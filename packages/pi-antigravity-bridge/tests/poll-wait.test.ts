// Long-waiting bridge_poll_result (issue #29): a running call holds the
// tools/call request up to POLL_WAIT_MS for an instant settle instead of
// returning STILL RUNNING per agy turn. Turn end and shutdown do not settle
// escalated entries (failAll spares them), so the abort and the window are
// the wake-up paths for abandoned polls.
//
// Run: npm test

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, test, vi } from "vitest";
import { answerPoll, EscalationRegistry, POLL_WAIT_MS, ToolRoundTrips } from "../src/provider.js";
import type { DriverActivity, DriverTurnRequest, StreamDriver } from "../src/driver.js";

const ESC = 20;

/** Minimal driver with a live turn handle: onToolCall refuses without an
 *  active antigravity turn. Shape mirrors provider-escalation.test.ts. */
class RecordingDriver {
	#handle = {
		id: "fake-turn",
		outcome: Promise.resolve({ status: "OK" as const, response: "ok", finished: true, aborted: false }),
		next: async (): Promise<DriverActivity | null> => null,
		pushExternal: (_a: DriverActivity) => {},
	};
	get activeHandle() {
		return this.#handle;
	}
	kickIdle(): void {}
	reentry() {
		return null;
	}
	run(_opts: DriverTurnRequest) {
		return Promise.resolve({ status: "OK" as const, response: "ok", finished: true, aborted: false });
	}
}

afterEach(() => {
	vi.useRealTimers();
});

/** A ToolRoundTrips with a running escalated entry, built on real timers
 *  (the escalation window must fire before the fake timers take over). */
async function escalatedRt(callId = "c1"): Promise<ToolRoundTrips> {
	const rt = new ToolRoundTrips(new RecordingDriver() as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	const res = await rt.onToolCall(callId, "bash", {}, new AbortController().signal);
	assert.deepEqual(res, { escalated: true, callId, name: "bash" });
	return rt;
}

test("the poll window stays under agy's request deadline and the delegation precedent", () => {
	assert.equal(POLL_WAIT_MS, 60_000);
});

test("waitForSettle resolves as soon as the call settles, well under the window", async () => {
	const rt = await escalatedRt();
	vi.useFakeTimers();
	const p = rt.waitForSettle("c1", POLL_WAIT_MS);
	assert.equal(vi.getTimerCount(), 1);
	assert.equal(rt.resolve("c1", "done text", false), true);
	await vi.advanceTimersByTimeAsync(1);
	await p;
	assert.equal(vi.getTimerCount(), 0, "the window timer is cleared on settle");
});

test("waitForSettle resolves at the window with the call still running", async () => {
	const rt = await escalatedRt();
	vi.useFakeTimers();
	const p = rt.waitForSettle("c1", POLL_WAIT_MS);
	await vi.advanceTimersByTimeAsync(POLL_WAIT_MS + 1);
	await p;
	assert.equal(rt.poll("c1")?.state, "running", "the timeout must not settle the entry");
});

test("waitForSettle resolves on abort and cleans up the listener", async () => {
	const rt = await escalatedRt();
	const ctrl = new AbortController();
	vi.useFakeTimers();
	const p = rt.waitForSettle("c1", POLL_WAIT_MS, ctrl.signal);
	assert.equal(getEventListeners(ctrl.signal, "abort").length, 1);
	ctrl.abort();
	await vi.advanceTimersByTimeAsync(1);
	await p;
	assert.equal(vi.getTimerCount(), 0, "the window timer is cleared on abort");
	assert.equal(getEventListeners(ctrl.signal, "abort").length, 0, "the abort listener is removed");
});

test("concurrent waiters on one callId both resolve on a single settle", async () => {
	const rt = await escalatedRt();
	vi.useFakeTimers();
	const p1 = rt.waitForSettle("c1", POLL_WAIT_MS);
	const p2 = rt.waitForSettle("c1", POLL_WAIT_MS);
	rt.resolve("c1", "done", false);
	await vi.advanceTimersByTimeAsync(1);
	await Promise.all([p1, p2]);
	assert.equal(vi.getTimerCount(), 0);
});

test("waitForSettle resolves immediately for unknown and already-terminal ids", async () => {
	const rt = await escalatedRt();
	assert.equal(rt.resolve("c1", "done", false), true);
	vi.useFakeTimers();
	await rt.waitForSettle("c1", POLL_WAIT_MS);
	await rt.waitForSettle("nope", POLL_WAIT_MS);
	assert.equal(vi.getTimerCount(), 0, "nothing to wait for means no timer");
	const fresh = new EscalationRegistry();
	await fresh.waitForSettle("nope", POLL_WAIT_MS);
});

test("answerPoll returns a terminal result with zero wait and marks delivered", async () => {
	const rt = await escalatedRt();
	assert.equal(rt.resolve("c1", "done text", false), true);
	vi.useFakeTimers();
	const r = await answerPoll(rt, "c1", new AbortController().signal);
	assert.equal(r.isError, false);
	assert.ok((r.content[0] as { text: string }).text.includes("done text"));
	assert.equal(rt.poll("c1")?.delivered, true);
	assert.equal(vi.getTimerCount(), 0, "no wait is armed for a terminal call");
});

test("answerPoll holds a running call and returns the settled result", async () => {
	const rt = await escalatedRt();
	vi.useFakeTimers();
	const ctrl = new AbortController();
	const p = answerPoll(rt, "c1", ctrl.signal);
	await vi.advanceTimersByTimeAsync(1);
	assert.ok(!rt.poll("c1")?.delivered);
	rt.resolve("c1", "SETTLED TEXT", false);
	await vi.advanceTimersByTimeAsync(1);
	const r = await p;
	assert.ok((r.content[0] as { text: string }).text.includes("SETTLED TEXT"));
	assert.equal(rt.poll("c1")?.delivered, true);
});

test("answerPoll skips markDelivered when the signal aborted, so the result stays undelivered", async () => {
	const rt = await escalatedRt();
	assert.equal(rt.resolve("c1", "stranded check", false), true);
	const ctrl = new AbortController();
	ctrl.abort();
	const r = await answerPoll(rt, "c1", ctrl.signal);
	assert.ok((r.content[0] as { text: string }).text.includes("stranded check"));
	assert.ok(!rt.poll("c1")?.delivered, "an aborted client never received the answer");
});

test("answerPoll answers an unknown callId immediately with the error text", async () => {
	const rt = new ToolRoundTrips(new RecordingDriver() as unknown as StreamDriver);
	vi.useFakeTimers();
	const r = await answerPoll(rt, "nope", new AbortController().signal);
	assert.equal(r.isError, true);
	assert.equal(vi.getTimerCount(), 0);
});
