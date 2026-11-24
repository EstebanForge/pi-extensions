import type { Message } from "@earendil-works/pi-ai";
import {
	historyCheckpoint,
	matchesCheckpoint,
	semanticMessageHash,
	serializeHistory,
	type HistoryCheckpoint,
	type HistoryEntry,
	type HistoryImage,
	type HistoryProjection,
} from "./history-projection.js";

export type SyncPhase = "idle" | "syncing" | "running" | "draining";

export interface SyncInFlight {
	turnId: string;
	base?: HistoryCheckpoint;
	target: HistoryCheckpoint;
	submission: "prepared" | "dispatching";
	expectedAssistantHash?: string;
}

export interface SessionSyncState {
	version: 1;
	epoch: number;
	checkpoint?: HistoryCheckpoint;
	expectedAssistantHash?: string;
	inFlight?: SyncInFlight;
	invalidReason?: string;
	/** Churn gate: after repeated rebuild-causing turns the session falls
	 *  back to digest behavior for its lifetime. Set by the provider. */
	digestFallback?: boolean;
}

export interface SyncOptions {
	continuation?: boolean;
	/** Predicate mirroring the provider's backlog-shape test (compaction
	 *  summaries, synthetic notes): a trailing-run member matching one is
	 *  history, never current input. Injected to keep this module pure. */
	isBacklogShape?: (text: string) => boolean;
}

export interface HistorySyncPlan {
	kind: "continue" | "rebuild" | "resume";
	reason: string;
	checkpoint?: HistoryCheckpoint;
	target: HistoryCheckpoint;
	history: HistoryEntry[];
	currentUser: HistoryEntry[];
	historyImages: HistoryImage[];
	embeddedContext?: string;
}

function hashValue(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function narrowCheckpoint(value: unknown): HistoryCheckpoint | undefined {
	if (!record(value) || !Number.isSafeInteger(value.entryCount) || (value.entryCount as number) < 0 || !hashValue(value.hash)) return;
	if (value.entryId !== undefined && typeof value.entryId !== "string") return;
	return {
		entryCount: value.entryCount as number,
		hash: value.hash,
		...(typeof value.entryId === "string" ? { entryId: value.entryId } : {}),
	};
}

/** Persist only the small protocol journal, never a second transcript. */
export function narrowSessionSync(value: unknown): SessionSyncState | undefined {
	if (!record(value) || value.version !== 1) return;
	const result: SessionSyncState = {
		version: 1,
		epoch: Number.isSafeInteger(value.epoch) && (value.epoch as number) >= 0 ? (value.epoch as number) : 0,
	};
	let malformed = false;
	if (value.checkpoint !== undefined) {
		result.checkpoint = narrowCheckpoint(value.checkpoint);
		malformed ||= result.checkpoint === undefined;
	}
	if (value.expectedAssistantHash !== undefined) {
		if (hashValue(value.expectedAssistantHash)) result.expectedAssistantHash = value.expectedAssistantHash;
		else malformed = true;
	}
	if (typeof value.invalidReason === "string") result.invalidReason = value.invalidReason;
	if (value.digestFallback === true) result.digestFallback = true;
	if (value.inFlight !== undefined) {
		const flight = value.inFlight;
		if (!record(flight) || typeof flight.turnId !== "string" || !flight.turnId || (flight.submission !== "prepared" && flight.submission !== "dispatching")) {
			malformed = true;
		} else {
			const target = narrowCheckpoint(flight.target);
			const base = flight.base === undefined ? undefined : narrowCheckpoint(flight.base);
			if (!target || (flight.base !== undefined && !base) || (flight.expectedAssistantHash !== undefined && !hashValue(flight.expectedAssistantHash))) {
				malformed = true;
			} else {
				result.inFlight = {
					turnId: flight.turnId,
					target,
					submission: flight.submission,
					...(base ? { base } : {}),
					...(hashValue(flight.expectedAssistantHash) ? { expectedAssistantHash: flight.expectedAssistantHash } : {}),
				};
			}
		}
	}
	if (malformed) result.invalidReason = "invalid-sync-state";
	return result;
}

function absorbAssistant(projection: HistoryProjection, base: HistoryCheckpoint | undefined, expected?: string): HistoryCheckpoint | undefined {
	if (!matchesCheckpoint(projection, base)) return;
	if (!expected) return base;
	const entry = projection.entries[base!.entryCount];
	if (entry?.role !== "assistant" || entry.hash !== expected) return;
	return historyCheckpoint(projection, base!.entryCount + 1);
}

/** A provider's returned assistant is not canonical until Pi echoes it back.
 *  Lenient on purpose: the stored checkpoint already claimed its span, so a
 *  foreign turn parked at the boundary rides the delta instead of forcing a
 *  rebuild; only a prefix mismatch invalidates. */
export function reconcileCheckpoint(projection: HistoryProjection, state?: SessionSyncState): HistoryCheckpoint | undefined {
	if (!matchesCheckpoint(projection, state?.checkpoint)) return;
	const expected = state?.expectedAssistantHash;
	const base = state!.checkpoint!;
	if (!expected) return base;
	const entry = projection.entries[base.entryCount];
	if (entry?.role !== "assistant" || entry.hash !== expected) return base;
	return historyCheckpoint(projection, base.entryCount + 1);
}

function entryText(entry: HistoryEntry): string {
	return entry.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** Trailing run of consecutive user entries, truncated at backlog-shaped
 *  members: compaction summaries and synthetic notes are history, never
 *  current input (issue #24's queued-run rule, entry-indexed). */
function trailingUserRunStart(projection: HistoryProjection, options: SyncOptions): number {
	const { entries } = projection;
	const end = entries.length;
	let start = end;
	for (let i = end - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.role !== "user") break;
		if (options.isBacklogShape?.(entryText(entry))) break;
		start = i;
	}
	return start;
}

export function planHistorySync(projection: HistoryProjection, state?: SessionSyncState, options: SyncOptions = {}): HistorySyncPlan {
	const checkpoint = reconcileCheckpoint(projection, state);
	let kind: HistorySyncPlan["kind"] = "continue";
	let reason = "matching-prefix";
	if (state?.invalidReason) {
		kind = "rebuild";
		reason = state.invalidReason;
	} else if (options.continuation && state?.inFlight) {
		const consumed = absorbAssistant(projection, state.inFlight.target, state.inFlight.expectedAssistantHash);
		if (!consumed) {
			kind = "rebuild";
			reason = "changed-inflight-prefix";
		} else if (projection.entries.slice(consumed.entryCount).some((entry) => entry.role === "user")) {
			kind = "rebuild";
			reason = "new-user-during-turn";
		} else {
			kind = "resume";
			reason = "live-tool-continuation";
		}
	} else if (state?.inFlight) {
		kind = "rebuild";
		reason = "unsettled-submission";
	} else if (!checkpoint) {
		kind = "rebuild";
		reason = state?.checkpoint ? "changed-prefix" : "missing-checkpoint";
	}

	const end = projection.entries.length;
	let currentStart = trailingUserRunStart(projection, options);
	// Earlier inputs of a confirmed-or-parked turn stay historical even when
	// Pi shows consecutive user messages without an assistant between them
	// (queued steering runs). Candidates kept through invalidation so a
	// cancellation cannot erase an earlier user.
	const priorInput = state?.inFlight?.target;
	const priorBoundary = matchesCheckpoint(projection, priorInput)
		? priorInput!.entryCount
		: matchesCheckpoint(projection, state?.checkpoint)
			? state!.checkpoint!.entryCount
			: 0;
	// Identical-retry guard: the parked target of a failed turn can cover the
	// whole transcript (entryCount == end). Clamping then yields an empty
	// current input and stalls pi's retry behind "No user message"; a
	// never-confirmed turn may re-send its user run.
	if (priorBoundary < end) currentStart = Math.max(currentStart, priorBoundary);
	const history = kind === "resume" ? [] : projection.entries.slice(kind === "rebuild" ? 0 : checkpoint!.entryCount, currentStart);
	return {
		kind,
		reason,
		...(checkpoint ? { checkpoint } : {}),
		target: historyCheckpoint(projection),
		history,
		currentUser: kind === "resume" ? [] : projection.entries.slice(currentStart),
		historyImages: history.flatMap((entry) => entry.images),
		...(history.length ? { embeddedContext: serializeHistory(history) } : {}),
	};
}

/** Controls one logical AGY turn across any number of Pi tool parks. Runtime
 *  liveness belongs to the caller: loading an inFlight record never revives it. */
export class SessionSyncCoordinator {
	#phase: SyncPhase = "idle";
	#state: SessionSyncState;
	#plan?: HistorySyncPlan;

	constructor(state?: SessionSyncState) {
		this.#state = narrowSessionSync(state) ?? { version: 1, epoch: 0 };
	}
	get phase(): SyncPhase {
		return this.#phase;
	}
	get snapshot(): SessionSyncState {
		return structuredClone(this.#state);
	}
	markDigestFallback(): void {
		this.#state.digestFallback = true;
	}

	prepare(projection: HistoryProjection, options: SyncOptions = {}): HistorySyncPlan {
		if (this.#phase !== "idle" && !(options.continuation && this.#phase === "running")) {
			throw new Error("Cannot synchronize while session is " + this.#phase);
		}
		this.#plan = planHistorySync(projection, this.#state, options);
		this.#phase = "syncing";
		return this.#plan;
	}

	bound(turnId: string): void {
		if (this.#phase !== "syncing" || !this.#plan) throw new Error("Synchronize before binding a turn");
		const plan = this.#plan;
		const continuing = plan.kind === "resume";
		if (continuing && this.#state.inFlight?.turnId !== turnId) throw new Error("Continuation belongs to another turn");
		const base = continuing ? this.#state.inFlight?.base : plan.kind === "continue" ? plan.checkpoint : undefined;
		if (plan.kind === "rebuild") this.#state.epoch++;
		this.#state = {
			version: 1,
			epoch: this.#state.epoch,
			...(this.#state.digestFallback ? { digestFallback: true } : {}),
			...(base ? { checkpoint: base } : {}),
			inFlight: { turnId, ...(base ? { base } : {}), target: plan.target, submission: continuing ? "dispatching" : "prepared" },
		};
		this.#phase = "running";
		this.#plan = undefined;
	}

	dispatching(): void {
		if (this.#phase !== "running" || !this.#state.inFlight) throw new Error("No running turn to submit");
		this.#state.inFlight.submission = "dispatching";
	}

	park(projection: HistoryProjection, assistant: Message): void {
		if (this.#phase !== "running" || !this.#state.inFlight) throw new Error("No running turn to park");
		this.#state.inFlight.target = historyCheckpoint(projection);
		this.#state.inFlight.expectedAssistantHash = semanticMessageHash(assistant);
		// A Pi toolUse response does not finish the remote session/prompt.
	}

	terminal(projection: HistoryProjection, assistant: Message): void {
		if (this.#phase !== "running") throw new Error("No running turn to settle");
		this.#state.checkpoint = historyCheckpoint(projection);
		this.#state.expectedAssistantHash = semanticMessageHash(assistant);
		delete this.#state.inFlight;
		this.#phase = "idle";
	}

	draining(): void {
		if (this.#phase !== "running" && this.#phase !== "syncing") throw new Error("No active turn to cancel");
		this.#phase = "draining";
	}

	/** Caller must first settle/close the old transport. Keep the inFlight
	 *  input boundary and unknown submission, so cancellation cannot erase an
	 *  earlier user. */
	invalidate(reason: string): void {
		this.#state.invalidReason = reason;
		this.#state.epoch++;
		this.#phase = "idle";
		this.#plan = undefined;
	}
}
