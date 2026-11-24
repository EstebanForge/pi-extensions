// Per-turn orchestrator for history-sync handoff turns (handoff = "sync").
//
// Wraps the pure plan/coordinator modules around one provider turn: prepare
// the plan from the pi transcript plus the session record, assemble the
// driver input (framed history resource block + deduped images), and settle
// the turn with the documented outcome ordering. Store writes stay with the
// provider (rotation guards live there); record() only builds the zeroed
// persist contract shape.
// Run: npm test

import { MAX_FRAME_BYTES } from "../frame-guard.js";
import { projectHistory, type HistoryProjection } from "../history-projection.js";
import { SessionSyncCoordinator, type HistorySyncPlan, type SessionSyncState, type SyncOptions } from "../history-sync.js";
import type { AgySession } from "../sessions.js";
import type { Message } from "@earendil-works/pi-ai";

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

export class AcpHistorySync {
	#coordinator: SessionSyncCoordinator;
	#messages: Message[];
	#conversationId: string | null;
	#options: AcpHistorySyncOptions;
	#plan: HistorySyncPlan;

	constructor(messages: readonly Message[], existing?: AgySession | null, options: AcpHistorySyncOptions = {}) {
		this.#messages = [...messages];
		this.#conversationId = existing?.conversationId ?? null;
		this.#options = options;
		this.#coordinator = new SessionSyncCoordinator(existing?.sync);
		this.#plan = this.#coordinator.prepare(this.#projection(), options);
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
		if (bytes > MAX_FRAME_BYTES) {
			throw new Error(`history-sync input exceeds the outbound frame budget (${bytes} bytes); compact the session and retry`);
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
		const known = priorConversationId ?? this.#conversationId;
		if (id && known && id !== known) {
			this.#coordinator.invalidate("unexpected-session-change");
			return { settled: "invalidated", reason: "unexpected-session-change" };
		}
		if (id && !known) this.#conversationId = id;
		if (outcome.aborted) {
			this.#coordinator.invalidate("interrupted");
			return { settled: "invalidated", reason: "interrupted" };
		}
		if (outcome.ok && outcome.promptTerminal) {
			this.#coordinator.terminal(this.#projectionOf(messages), assistant);
			return { settled: "terminal" };
		}
		const reason = outcome.promptAttempted ? "delivery-unknown" : "unconfirmed-turn";
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
