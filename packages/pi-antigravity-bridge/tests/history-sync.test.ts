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

	it("absorbs an echoed assistant one step, but not a different one", () => {
		const a1 = assistant("reply-1", 2);
		const projection = projectHistory([user("a", 1), a1]);
		const base = historyCheckpoint(projection, 1);
		const good = reconcileCheckpoint(projection, { version: 1, epoch: 0, checkpoint: base, expectedAssistantHash: semanticMessageHash(a1) });
		expect(good?.entryCount).toBe(2);
		const bad = reconcileCheckpoint(projection, { version: 1, epoch: 0, checkpoint: base, expectedAssistantHash: "d".repeat(64) });
		expect(bad).toBeUndefined();
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
	});

	it("resumes a live continuation and refuses new user input mid-turn", () => {
		const projection = projectHistory([user("a", 1), assistant("r", 2)]);
		const target = historyCheckpoint(projection);
		const inFlight = { turnId: "t1", target, submission: "prepared" as const };
		const resumed = planHistorySync(projection, { version: 1, epoch: 0, checkpoint: historyCheckpoint(projection, 1), inFlight }, { continuation: true });
		expect(resumed).toMatchObject({ kind: "resume", reason: "live-tool-continuation", history: [], currentUser: [] });
		const withNewUser = projectHistory([user("a", 1), assistant("r", 2), user("steer", 3)]);
		expect(planHistorySync(withNewUser, { version: 1, epoch: 0, inFlight }, { continuation: true })).toMatchObject({ kind: "rebuild", reason: "new-user-during-turn" });
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
		// [u1, A(toolUse), u2] where the turn parked covering u1..A; u2 is the
		// only new input on the retry request.
		const parked = projectHistory([user("a", 1), assistant("r", 2)]);
		const projection = projectHistory([user("a", 1), assistant("r", 2), user("b", 3)]);
		const target = historyCheckpoint(parked);
		const plan = planHistorySync(projection, { version: 1, epoch: 1, invalidReason: "interrupted", inFlight: { turnId: "t1", target, submission: "dispatching" } }, { isBacklogShape });
		expect(plan.currentUser.map((e) => e.sourceIndex)).toEqual([2]);
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
