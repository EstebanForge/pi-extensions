// Per-turn orchestrator for history-sync handoff turns (handoff = "sync").
//
// Wraps the pure plan/coordinator modules around one provider turn: prepare
// the plan from the pi transcript plus the session record, assemble the
// driver input (framed history resource block + deduped images), and settle
// the turn with the documented outcome ordering. Store writes stay with the
// provider (rotation guards live there); record() only builds the zeroed
// persist contract shape.
// Run: npm test

import { projectHistory, type HistoryProjection } from "../history-projection.js";
import { SessionSyncCoordinator, type HistorySyncPlan, type SessionSyncState, type SyncOptions } from "../history-sync.js";
import type { AgySession } from "../sessions.js";
import type { Message } from "@earendil-works/pi-ai";

/** Thrown by inputFor when the framed turn would exceed the outbound budget;
 *  the provider uses it to report a budget refusal without string matching. */
export class OutboundFrameBudgetError extends Error {}

export interface AcpHistorySyncOptions extends SyncOptions {}

export interface SyncTurnOutcome {
	ok: boolean;
	conversationId?: string | null;
	/** The driver invoked the transport prompt call (weaker than delivery). */
	promptAttempted?: boolean;
	/** The transport reported a terminal result for the prompt. */
	promptTerminal?: boolean;
	aborted?: boolean;
}

export interface SyncInput {
	prompt: string;
	images?: Array<{ data: string; mimeType: string }>;
	contextBlock?: { uri: string; text: string };
}

export type SyncFinishResult = { settled: "terminal" } | { settled: "invalidated"; reason: string };

const HISTORY_URI = "urn:pi-bridge:history:v1";
const FRAME_MARGIN_BYTES = 2048;
// The engine ACCEPTS outbound frames past ~3.8MiB but silently truncates
// the resource there (probe-acp-frame 2026-11-24: "truncated at 4002908
// bytes" on a 4MiB block), so the lossless budget sits safely below the
// truncation point - well under frame-guard's 32MiB inbound cap.
const OUTBOUND_FRAME_BUDGET_BYTES = 3 * 1024 * 1024;

export class AcpHistorySync {
	#coordinator: SessionSyncCoordinator;
	#messages: Message[];
	#conversationId: string | null;
	#options: AcpHistorySyncOptions;
	#plan: HistorySyncPlan;

	constructor(messages: readonly Message[], existing?: AgySession | null, options: AcpHistorySyncOptions = {}) {
		this.#messages = [...messages];
		this.#options = options;
		this.#coordinator = new SessionSyncCoordinator(existing?.sync);
		this.#plan = this.#coordinator.prepare(this.#projection(), options);
		// A rebuild deliberately starts a fresh conversation: the tracked id
		// must be null so the outcome id is adopted instead of classified as a
		// binding change, and a mid-turn crash cannot resurrect the stale id.
		this.#conversationId = this.#plan.kind === "rebuild" ? null : (existing?.conversationId ?? null);
	}

	#projection(): HistoryProjection {
		return projectHistory(this.#messages);
	}

	get plan(): HistorySyncPlan {
		return this.#plan;
	}

	/** A rebuild always starts a fresh conversation, even over an old binding. */
	get freshConversation(): boolean {
		return this.#plan.kind === "rebuild";
	}

	/** Null while an unbound rebuild is pending; warm sessions keep theirs. */
	get boundConversationId(): string | null {
		return this.#plan.kind === "rebuild" ? null : this.#conversationId;
	}

	get snapshot(): SessionSyncState {
		return this.#coordinator.snapshot;
	}

	/** Re-plan from idle (multi-turn reuse); the constructor already planned. */
	prepare(): HistorySyncPlan {
		this.#plan = this.#coordinator.prepare(this.#projection(), this.#options);
		return this.#plan;
	}

	bound(turnId: string): void {
		this.#coordinator.bound(turnId);
	}

	/** Write-ahead adoption from the driver's onSessionBound hook: the fresh
	 *  conversation id is known before the prompt, so a mid-turn crash still
	 *  persists the right binding. No-op once tracked. */
	adoptBinding(sessionId: string): void {
		if (!this.#conversationId) this.#conversationId = sessionId;
	}

	/** Session/load failed: invalidate, re-plan as a rebuild over the same
	 *  transcript, unbind, and return the complete fresh-conversation input
	 *  (system-prompt-bearing prompt plus full history block and images).
	 *  The recreated conversation is adopted by the next finish, not treated
	 *  as a binding change. */
	loadFailed(request: { prompt: string; images?: Array<{ data: string; mimeType: string }> }): SyncInput {
		this.#coordinator.invalidate("session-load-failed");
		this.#conversationId = null;
		this.#plan = this.#coordinator.prepare(this.#projection(), { ...this.#options, continuation: false });
		return this.inputFor(request);
	}

	dispatching(): void {
		this.#coordinator.dispatching();
	}

	park(messages: readonly Message[], assistant: Message): void {
		this.#coordinator.park(projectHistory(messages), assistant);
	}

	terminal(messages: readonly Message[], assistant: Message, conversationId?: string | null): void {
		this.#coordinator.terminal(projectHistory(messages), assistant);
		if (conversationId) this.#conversationId = conversationId;
	}

	invalidate(reason: string): void {
		this.#coordinator.invalidate(reason);
	}

	/** Churn-gate latch: the session goes back to the digest flow after this
	 *  turn's record persists. */
	markDigestFallback(): void {
		this.#coordinator.markDigestFallback();
	}

	/** Assemble the driver turn input: prompt, request + deduped history
	 *  images, and the framed history resource block when history is owed.
	 *  Hard-fails over the frame budget — history is never truncated. */
	inputFor(request: { prompt: string; images?: Array<{ data: string; mimeType: string }> }): SyncInput {
		const images = [...(request.images ?? [])];
		const seen = new Set(images.map((image) => image.mimeType + ":" + image.data));
		for (const image of this.#plan.historyImages) {
			const key = image.mimeType + ":" + image.data;
			if (seen.has(key)) continue;
			seen.add(key);
			images.push({ data: image.data, mimeType: image.mimeType });
		}
		const input: SyncInput = { prompt: request.prompt, ...(images.length ? { images } : {}) };
		if (this.#plan.history.length > 0 && this.#plan.embeddedContext) {
			input.contextBlock = { uri: HISTORY_URI, text: this.#plan.embeddedContext };
		}
		const bytes = Buffer.byteLength(JSON.stringify(input)) + FRAME_MARGIN_BYTES;
		if (bytes > OUTBOUND_FRAME_BUDGET_BYTES) {
			throw new OutboundFrameBudgetError(
				`history-sync input exceeds the outbound frame budget (${bytes} bytes); compact the session to shrink history, or shorten the prompt, then retry`,
			);
		}
		return input;
	}

	/** Settle the turn per the documented ordering: binding mismatch first,
	 *  then adopt, then abort-before-terminal, then OK/terminal, then the
	 *  delivery-unknown and unconfirmed-turn invalidations. */
	finish(
		outcome: SyncTurnOutcome,
		assistant: Message,
		messages: readonly Message[],
		priorConversationId?: string | null,
	): SyncFinishResult {
		const id = outcome.conversationId ?? null;
		// A rebuild EXPECTS a new conversation: only compare against a prior
		// binding when the plan continued a warm session.
		const known = this.freshConversation ? null : (priorConversationId ?? this.#conversationId);
		if (id && known && id !== known) {
			this.#coordinator.invalidate("unexpected-session-change");
			return { settled: "invalidated", reason: "unexpected-session-change" };
		}
		if (id && this.#conversationId !== id) this.#conversationId = id;
		if (outcome.aborted) {
			this.#coordinator.invalidate("interrupted");
			return { settled: "invalidated", reason: "interrupted" };
		}
		if (outcome.ok && outcome.promptTerminal && this.#coordinator.settleable) {
			this.#coordinator.terminal(this.#projectionOf(messages), assistant);
			return { settled: "terminal" };
		}
		if (outcome.ok && outcome.promptTerminal) {
			// Driver-confirmed delivery, but the turn was never bound (provider
			// contract violation or an unwired hook): the checkpoint cannot
			// absorb, so force the named rebuild instead of crashing terminal().
			this.#coordinator.invalidate("unsettled-terminal");
			return { settled: "invalidated", reason: "unsettled-terminal" };
		}
		// A terminal-but-failed outcome (refusal, engine error with a result
		// frame) IS confirmed delivery - only an attempted prompt that never
		// went terminal stays delivery-unknown; everything else never left.
		const reason = outcome.promptAttempted && !outcome.promptTerminal ? "delivery-unknown" : "unconfirmed-turn";
		this.#coordinator.invalidate(reason);
		return { settled: "invalidated", reason };
	}

	#projectionOf(messages: readonly Message[]): HistoryProjection {
		return projectHistory(messages);
	}

	/** Zeroed persist-contract record: digest watermark fields zeroed so a
	 *  later digest flip re-offers the backlog once, safely. Null
	 *  conversationId means the caller skips persisting. */
	record(): Omit<AgySession, 'conversationId'> & { conversationId: string | null } {
		return {
			conversationId: this.#conversationId,
			lastStepIdx: -1,
			lastMessageCount: 0,
			sync: this.#coordinator.snapshot,
		};
	}
}
