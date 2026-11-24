import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import {
	historyCheckpoint,
	projectHistory,
	semanticMessageHash,
} from "../src/history-projection.js";
import {
	SessionSyncCoordinator,
	narrowSessionSync,
	planHistorySync,
	reconcileCheckpoint,
	type SessionSyncState,
} from "../src/history-sync.js";

const user = (text: string, ts = 1000): Message => ({ role: "user", content: text, timestamp: ts });
const toolResult = (ts = 3000): Message => ({ role: "toolResult", toolCallId: "t1", toolName: "read", isError: false, content: [{ type: "text", text: "out" }], timestamp: ts });
const assistant = (text: string, ts = 2000, stopReason = "stop"): Message => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "agy-bridge" as never,
	provider: "antigravity" as never,
	model: "m",
	usage: {} as never,
	stopReason: stopReason as never,
	timestamp: ts,
});

// Mirrors provider.ts isBacklogUserShape: compaction summaries and synthetic
// notes are history, never current input.
const isBacklogShape = (text: string) => text.includes("[COMPACTION]") || text.startsWith("Ran ");

describe("narrowSessionSync", () => {
	it("round-trips a valid state", () => {
		const state: SessionSyncState = {
			version: 1,
			epoch: 2,
			checkpoint: { entryCount: 3, hash: "a".repeat(64), entryId: "m2-abc" },
			expectedAssistantHash: "b".repeat(64),
			inFlight: { turnId: "t1", target: { entryCount: 4, hash: "c".repeat(64) }, submission: "dispatching" },
			digestFallback: true,
		};
		expect(narrowSessionSync(structuredClone(state))).toEqual(state);
	});

	it("defaults epoch and marks malformed pieces invalid-sync-state", () => {
		expect(narrowSessionSync({ version: 1 })?.epoch).toBe(0);
		const bad = narrowSessionSync({ version: 1, checkpoint: { entryCount: 1, hash: "nope" } });
		expect(bad?.invalidReason).toBe("invalid-sync-state");
		expect(narrowSessionSync({ version: 1, inFlight: { turnId: "t", target: { entryCount: 1, hash: "a".repeat(64) }, submission: "weird" } })?.invalidReason).toBe("invalid-sync-state");
		expect(narrowSessionSync({ version: 2 })).toBeUndefined();
		expect(narrowSessionSync("nope")).toBeUndefined();
	});
});

describe("reconcileCheckpoint", () => {
	it("returns undefined without state and passes a matching checkpoint through", () => {
		const projection = projectHistory([user("a", 1), user("b", 2)]);
		expect(reconcileCheckpoint(projection, undefined)).toBeUndefined();
		const cp = historyCheckpoint(projection, 1);
		expect(reconcileCheckpoint(projection, { version: 1, epoch: 0, checkpoint: cp })).toEqual(cp);
	});

	it("absorbs an echoed assistant one step, keeps the base on anything else", () => {
		const a1 = assistant("reply-1", 2);
		const projection = projectHistory([user("a", 1), a1]);
		const base = historyCheckpoint(projection, 1);
		const good = reconcileCheckpoint(projection, { version: 1, epoch: 0, checkpoint: base, expectedAssistantHash: semanticMessageHash(a1) });
		expect(good?.entryCount).toBe(2);
		// a different assistant at the boundary is foreign content: the base
		// stands and the turn rides the delta instead of forcing a rebuild
		const foreign = reconcileCheckpoint(projection, { version: 1, epoch: 0, checkpoint: base, expectedAssistantHash: "d".repeat(64) });
		expect(foreign).toEqual(base);
		// a foreign user turn at the boundary likewise leaves the base intact
		const withForeign = projectHistory([user("a", 1), user("other-provider", 3)]);
		expect(reconcileCheckpoint(withForeign, { version: 1, epoch: 0, checkpoint: base, expectedAssistantHash: semanticMessageHash(a1) })).toEqual(base);
		// only a prefix mismatch invalidates
		expect(reconcileCheckpoint(projection, { version: 1, epoch: 0, checkpoint: { entryCount: 1, hash: "e".repeat(64) }, expectedAssistantHash: semanticMessageHash(a1) })).toBeUndefined();
	});
});

describe("planHistorySync decisions", () => {
	it("continues on a matching checkpoint", () => {
		const projection = projectHistory([user("a", 1), assistant("r", 2), user("b", 3)]);
		const cp = historyCheckpoint(projection, 2);
		const plan = planHistorySync(projection, { version: 1, epoch: 0, checkpoint: cp });
		expect(plan.kind).toBe("continue");
		expect(plan.reason).toBe("matching-prefix");
		// nothing new between the checkpoint and the trailing user run
		expect(plan.history.map((e) => e.sourceIndex)).toEqual([]);
		// the trailing user IS the current prompt
		expect(plan.currentUser.map((e) => e.sourceIndex)).toEqual([2]);
		expect(plan.target).toEqual(historyCheckpoint(projection));
	});

	it("continues with a delta when history grew past the checkpoint", () => {
		const projection = projectHistory([user("a", 1), assistant("r", 2), user("other-provider", 3), assistant("fr", 4), user("b", 5)]);
		const cp = historyCheckpoint(projection, 2);
		const plan = planHistorySync(projection, { version: 1, epoch: 0, checkpoint: cp });
		expect(plan.kind).toBe("continue");
		// the foreign-provider exchange is the owed delta; the trailing user is the prompt
		expect(plan.history.map((e) => e.sourceIndex)).toEqual([2, 3]);
		expect(plan.currentUser.map((e) => e.sourceIndex)).toEqual([4]);
		expect(plan.embeddedContext).toBeDefined();
	});

	it("rebuilds with named reasons in order", () => {
		const projection = projectHistory([user("a", 1)]);
		expect(planHistorySync(projection, { version: 1, epoch: 0, invalidReason: "interrupted" }).reason).toBe("interrupted");
		expect(planHistorySync(projection, { version: 1, epoch: 0, inFlight: { turnId: "t", target: historyCheckpoint(projection), submission: "prepared" } })).toMatchObject({ kind: "rebuild", reason: "unsettled-submission" });
		expect(planHistorySync(projection, { version: 1, epoch: 0, checkpoint: { entryCount: 1, hash: "f".repeat(64) } })).toMatchObject({ kind: "rebuild", reason: "changed-prefix" });
		expect(planHistorySync(projection)).toMatchObject({ kind: "rebuild", reason: "missing-checkpoint" });
		// invalidReason wins even over a matching continuation inFlight
		const cp = historyCheckpoint(projection);
		const matching = { turnId: "t1", target: cp, submission: "dispatching" as const };
		expect(planHistorySync(projection, { version: 1, epoch: 1, invalidReason: "interrupted", inFlight: matching }, { continuation: true }).reason).toBe("interrupted");
		// continuation with no inFlight and a matching checkpoint keeps the
		// warm session: the recycle rule must key on plan.kind, not the reason
		expect(planHistorySync(projection, { version: 1, epoch: 0, checkpoint: cp }, { continuation: true })).toMatchObject({ kind: "continue", reason: "matching-prefix" });
	});

	it("resumes from the real park shape: request target + echoed assistant", () => {
		// park() stores the REQUEST projection (pre-assistant) plus the hash of
		// the streaming assistant; the absorb fires when pi echoes that exact
		// assistant back as entries[target.entryCount].
		const u1 = user("a", 1);
		const a1 = assistant("reply", 2);
		const request = projectHistory([u1]);
		const target = historyCheckpoint(request);
		const tr: Message = { role: "toolResult", toolCallId: "t1", toolName: "read", isError: false, content: [{ type: "text", text: "out" }], timestamp: 3 };
		const echo = projectHistory([u1, a1, tr]);
		const state = { version: 1 as const, epoch: 0, checkpoint: target, inFlight: { turnId: "t1", target, submission: "prepared" as const, expectedAssistantHash: semanticMessageHash(a1) } };
		const resumed = planHistorySync(echo, state, { continuation: true });
		expect(resumed).toMatchObject({ kind: "resume", reason: "live-tool-continuation", history: [], currentUser: [] });
		// steer input after the tool result is new user input mid-turn
		const withSteer = projectHistory([u1, a1, tr, user("steer", 4)]);
		expect(planHistorySync(withSteer, state, { continuation: true })).toMatchObject({ kind: "rebuild", reason: "new-user-during-turn" });
		// a rewritten assistant does not match the parked hash
		const rewritten = projectHistory([u1, assistant("rewritten", 2), tr]);
		expect(planHistorySync(rewritten, state, { continuation: true })).toMatchObject({ kind: "rebuild", reason: "changed-inflight-prefix" });
	});

	it("rebuilds changed-inflight-prefix when the parked target no longer matches", () => {
		const target = historyCheckpoint(projectHistory([user("a", 1), assistant("r", 2)]));
		const projection = projectHistory([user("a", 1), assistant("r2", 2), assistant("r3", 3)]);
		expect(planHistorySync(projection, { version: 1, epoch: 0, inFlight: { turnId: "t1", target, submission: "dispatching" } }, { continuation: true })).toMatchObject({ kind: "rebuild", reason: "changed-inflight-prefix" });
	});

	it("ships embeddedContext only when history is non-empty", () => {
		const projection = projectHistory([user("a", 1)]);
		const rebuild = planHistorySync(projection);
		// the whole transcript is one current user run: nothing is history
		expect(rebuild.history).toHaveLength(0);
		expect(rebuild.embeddedContext).toBeUndefined();
		const fuller = projectHistory([user("a", 1), assistant("r", 2), user("b", 3)]);
		const plan = planHistorySync(fuller);
		expect(plan.history.map((e) => e.sourceIndex)).toEqual([0, 1]);
		expect(plan.embeddedContext).toBeDefined();
		expect(plan.historyImages).toHaveLength(0);
	});
});

describe("current-input boundary", () => {
	it("merges adjacent user messages into one run", () => {
		const projection = projectHistory([user("a", 1), user("b", 2)]);
		const plan = planHistorySync(projection);
		expect(plan.currentUser.map((e) => e.sourceIndex)).toEqual([0, 1]);
		expect(plan.history).toHaveLength(0);
	});

	it("truncates the run at backlog shapes, keeping them as history", () => {
		const projection = projectHistory([user("note: [COMPACTION] summary here", 1), user("real prompt", 2)]);
		const plan = planHistorySync(projection, undefined, { isBacklogShape });
		expect(plan.currentUser.map((e) => e.sourceIndex)).toEqual([1]);
		expect(plan.history.map((e) => e.sourceIndex)).toEqual([0]);
	});

	it("produces no current input when the transcript does not end in a user entry", () => {
		const projection = projectHistory([user("a", 1), assistant("r", 2)]);
		expect(planHistorySync(projection).currentUser).toHaveLength(0);
	});

	it("extends history past consecutive users via a matching inFlight target", () => {
		// [u1, u2] consecutive users with the parked target covering u1 only:
		// the boundary clamp keeps u1 historical even with no assistant between
		const projection = projectHistory([user("a", 1), user("b", 2)]);
		const target = historyCheckpoint(projectHistory([user("a", 1)]));
		const plan = planHistorySync(projection, { version: 1, epoch: 1, invalidReason: "interrupted", inFlight: { turnId: "t1", target, submission: "dispatching" } }, { isBacklogShape });
		expect(plan.currentUser.map((e) => e.sourceIndex)).toEqual([1]);
		expect(plan.history.map((e) => e.sourceIndex)).toEqual([0]);
		expect(plan.kind).toBe("rebuild");
	});

	it("does not clamp on an identical retry (priorBoundary == end)", () => {
		// Failed turn covered the whole transcript incl. u1; pi retries with
		// the same transcript minus the dropped assistant. The clamp must NOT
		// yield an empty current input.
		const projection = projectHistory([user("a", 1)]);
		const target = historyCheckpoint(projection); // entryCount == end
		const plan = planHistorySync(projection, { version: 1, epoch: 1, invalidReason: "delivery-unknown", inFlight: { turnId: "t1", target, submission: "dispatching" } });
		expect(plan.currentUser.map((e) => e.sourceIndex)).toEqual([0]);
		expect(plan.history).toHaveLength(0);
	});
});

describe("SessionSyncCoordinator", () => {
	const mkProjection = () => projectHistory([user("a", 1)]);

	it("runs prepare → bound → dispatching → park → terminal", () => {
		const coordinator = new SessionSyncCoordinator();
		const projection = mkProjection();
		const plan = coordinator.prepare(projection);
		expect(plan.kind).toBe("rebuild");
		coordinator.bound("t1");
		expect(coordinator.phase).toBe("running");
		expect(coordinator.snapshot.epoch).toBe(1); // rebuild bumps
		expect(coordinator.snapshot.inFlight).toMatchObject({ turnId: "t1", submission: "prepared" });
		coordinator.dispatching();
		expect(coordinator.snapshot.inFlight?.submission).toBe("dispatching");
		coordinator.terminal(projection, assistant("r", 2));
		expect(coordinator.phase).toBe("idle");
		const snap = coordinator.snapshot;
		expect(snap.checkpoint).toEqual(historyCheckpoint(projection));
		expect(snap.expectedAssistantHash).toBe(semanticMessageHash(assistant("r", 2)));
		expect(snap.inFlight).toBeUndefined();
	});

	it("resume requires the same turn id and continuation while running", () => {
		const coordinator = new SessionSyncCoordinator({
			version: 1,
			epoch: 0,
			checkpoint: historyCheckpoint(mkProjection()),
			inFlight: { turnId: "t1", target: historyCheckpoint(mkProjection()), submission: "prepared" },
		});
		const projection = mkProjection();
		const plan = coordinator.prepare(projection, { continuation: true });
		expect(plan.kind).toBe("resume");
		expect(coordinator.snapshot.epoch).toBe(0); // resume does not bump
		expect(() => coordinator.bound("t2")).toThrow(/another turn/);
		// state retained after the failed binding attempt
		expect(coordinator.snapshot.inFlight?.turnId).toBe("t1");
	});

	it("invalidate keeps the inFlight input boundary and bumps epoch", () => {
		const projection = mkProjection();
		const coordinator = new SessionSyncCoordinator();
		coordinator.prepare(projection);
		coordinator.bound("t1");
		coordinator.invalidate("interrupted");
		const snap = coordinator.snapshot;
		expect(snap.invalidReason).toBe("interrupted");
		expect(snap.epoch).toBe(2);
		expect(snap.inFlight?.turnId).toBe("t1");
		expect(coordinator.phase).toBe("idle");
	});

	it("carries a park through resume to a confirmed terminal checkpoint", () => {
		const u1 = user("a", 1);
		const a1 = assistant("reply", 2);
		const a2 = assistant("final", 3);
		const tr = toolResult(4);
		const request = projectHistory([u1]);
		const coordinator = new SessionSyncCoordinator();
		coordinator.prepare(request);
		coordinator.bound("t1");
		coordinator.dispatching();
		// park stores the request projection + the streaming assistant hash;
		// submission is untouched (a parked prompt never finished)
		coordinator.park(request, a1);
		expect(coordinator.snapshot.inFlight).toMatchObject({ turnId: "t1", submission: "dispatching" });
		expect(coordinator.snapshot.inFlight?.target).toEqual(historyCheckpoint(request));
		expect(coordinator.snapshot.inFlight?.expectedAssistantHash).toBe(semanticMessageHash(a1));
		// pi echoes assistant + tool result; the coordinator resumes in place
		const echo = projectHistory([u1, a1, tr]);
		const resumed = coordinator.prepare(echo, { continuation: true });
		expect(resumed.kind).toBe("resume");
		coordinator.bound("t1");
		// resume-bound keeps the conservative pre-turn base: the assistant is
		// only claimed by terminal's full-projection checkpoint
		expect(coordinator.snapshot.checkpoint).toBeUndefined();
		expect(coordinator.snapshot.inFlight?.target).toEqual(historyCheckpoint(echo));
		expect(coordinator.snapshot.inFlight?.submission).toBe("dispatching");
		// turn ends: terminal claims the PRE-assistant projection + the echo
		// hash; the assistant enters the checkpoint only when pi echoes it back
		const settleBase = projectHistory([u1, a1, tr]);
		coordinator.terminal(settleBase, a2);
		const settled = coordinator.snapshot;
		expect(settled.checkpoint).toEqual(historyCheckpoint(settleBase));
		expect(settled.expectedAssistantHash).toBe(semanticMessageHash(a2));
		expect(settled.inFlight).toBeUndefined();
		// next turn: the echoed a2 absorbs one step, the new user is input
		const next = coordinator.prepare(projectHistory([u1, a1, tr, a2, user("b", 5)]));
		expect(next.kind).toBe("continue");
		expect(next.checkpoint).toEqual(historyCheckpoint(projectHistory([u1, a1, tr, a2]), 4));
		expect(next.currentUser.map((e) => e.sourceIndex)).toEqual([4]);
		expect(next.history).toHaveLength(0);
	});

	it("bound() clears invalidReason after invalidation", () => {
		const projection = mkProjection();
		const coordinator = new SessionSyncCoordinator();
		coordinator.prepare(projection);
		coordinator.bound("t1");
		coordinator.invalidate("interrupted");
		expect(coordinator.snapshot.invalidReason).toBe("interrupted");
		coordinator.prepare(projection);
		coordinator.bound("t2");
		expect(coordinator.snapshot.invalidReason).toBeUndefined();
	});

	it("drains from running or syncing and guards phase transitions", () => {
		const coordinator = new SessionSyncCoordinator();
		expect(() => coordinator.dispatching()).toThrow();
		const projection = mkProjection();
		coordinator.prepare(projection);
		coordinator.draining();
		expect(coordinator.phase).toBe("draining");
		expect(() => coordinator.terminal(projection, assistant("r", 2))).toThrow();
		expect(() => coordinator.prepare(projection)).toThrow(/draining/);
	});

	it("latches digestFallback through narrow round-trips", () => {
		const coordinator = new SessionSyncCoordinator();
		coordinator.markDigestFallback();
		expect(coordinator.snapshot.digestFallback).toBe(true);
		expect(narrowSessionSync(coordinator.snapshot)?.digestFallback).toBe(true);
	});
});
