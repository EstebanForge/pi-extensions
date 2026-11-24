// Unit tests for the per-turn history-sync orchestrator (src/acp/history-sync.ts).
//
// Pins the plan preparation over a real session record, the input assembly
// (image dedupe, framing, byte guard) and the finish() outcome ordering:
// rebuild-over-record adopts the fresh conversation id, abort wins over
// terminal, a confirmed-but-unbound settle invalidates as unsettled-terminal,
// delivery-unknown over unconfirmed-turn, and a warm-session binding
// mismatch invalidates with a named reason.
// Run: npm test

import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { historyCheckpoint, projectHistory, semanticMessageHash, serializeHistory } from "../src/history-projection.js";
import type { AgySession } from "../src/sessions.js";
import { AcpHistorySync } from "../src/acp/history-sync.js";

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

describe("AcpHistorySync prepare", () => {
	it("plans a rebuild for a fresh session with no record", () => {
		const sync = new AcpHistorySync([user("hello", 1)], undefined);
		expect(sync.plan.kind).toBe("rebuild");
		expect(sync.plan.reason).toBe("missing-checkpoint");
		// the single user run is current input, not history
		expect(sync.plan.currentUser.map((e) => e.sourceIndex)).toEqual([0]);
		expect(sync.plan.history).toHaveLength(0);
		expect(sync.freshConversation).toBe(true);
		expect(sync.boundConversationId).toBeNull();
	});

	it("plans a continue with a delta for a warm record", () => {
		const projection = projectHistory([user("a", 1), assistant("r", 2), user("other", 3), assistant("fr", 4), user("b", 5)]);
		const existing: AgySession = {
			conversationId: "conv-1",
			lastStepIdx: -1,
			lastMessageCount: 0,
			sync: { version: 1, epoch: 0, checkpoint: historyCheckpoint(projection, 2) },
		};
		const sync = new AcpHistorySync(
			[user("a", 1), assistant("r", 2), user("other", 3), assistant("fr", 4), user("b", 5)],
			existing,
		);
		expect(sync.plan.kind).toBe("continue");
		expect(sync.plan.history.map((e) => e.sourceIndex)).toEqual([2, 3]);
		expect(sync.plan.currentUser.map((e) => e.sourceIndex)).toEqual([4]);
		expect(sync.freshConversation).toBe(false);
		expect(sync.boundConversationId).toBe("conv-1");
	});

	it("forces a fresh conversation on a rebuild over an old binding", () => {
		const projection = projectHistory([user("a", 1), assistant("r", 2)]);
		const existing: AgySession = {
			conversationId: "conv-stale",
			lastStepIdx: -1,
			lastMessageCount: 0,
			sync: { version: 1, epoch: 3, invalidReason: "interrupted", inFlight: { turnId: "t0", target: historyCheckpoint(projection), submission: "dispatching" } },
		};
		const sync = new AcpHistorySync([user("a", 1), assistant("r", 2), user("again", 3)], existing);
		expect(sync.plan.kind).toBe("rebuild");
		// rebuild starts a fresh conversation even though a binding exists
		expect(sync.freshConversation).toBe(true);
		expect(sync.boundConversationId).toBeNull();
	});
});

describe("AcpHistorySync inputFor", () => {
	it("passes the prompt through and frames non-empty history as a resource block", () => {
		// the foreign-provider exchange between checkpoint and prompt is owed
		const messages = [user("a", 1), assistant("r", 2), user("other", 3), assistant("fr", 4), user("b", 5)];
		const projection = projectHistory(messages);
		const existing: AgySession = {
			conversationId: "conv-1",
			lastStepIdx: -1,
			lastMessageCount: 0,
			sync: { version: 1, epoch: 0, checkpoint: historyCheckpoint(projection, 2) },
		};
		const sync = new AcpHistorySync(messages, existing);
		const input = sync.inputFor({ prompt: "do the thing" });
		expect(input.prompt).toBe("do the thing");
		expect(input.contextBlock).toMatchObject({ uri: "urn:pi-bridge:history:v1" });
		expect(input.contextBlock?.text).toBe(serializeHistory(sync.plan.history));
		expect(input.images).toBeUndefined();
	});

	it("omits the context block when history is empty", () => {
		const sync = new AcpHistorySync([user("hello", 1)], undefined);
		const input = sync.inputFor({ prompt: "hi" });
		expect(input.contextBlock).toBeUndefined();
	});

	it("dedupes history images against request images by mimeType:data", () => {
		const image = { type: "image" as const, data: "aGk=", mimeType: "image/png" };
		const m: Message = { role: "user", content: [image], timestamp: 1 };
		const sync = new AcpHistorySync([m, assistant("r", 2), user("go", 3)], undefined);
		const input = sync.inputFor({ prompt: "again", images: [{ data: "aGk=", mimeType: "image/png" }] });
		// the same pixels ride once: request copy wins, history copy deduped
		expect(input.images).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
		// a distinct history image still ships
		const other = { type: "image" as const, data: "eHk=", mimeType: "image/jpeg" };
		const sync2 = new AcpHistorySync([{ role: "user", content: [other], timestamp: 1 } as Message, assistant("r", 2), user("go", 3)], undefined);
		const input2 = sync2.inputFor({ prompt: "again", images: [{ data: "aGk=", mimeType: "image/png" }] });
		expect(input2.images).toEqual([
			{ data: "aGk=", mimeType: "image/png" },
			{ data: "eHk=", mimeType: "image/jpeg" },
		]);
	});

	it("hard-fails past the engine-side truncation band", () => {
		// The engine accepts outbound frames past ~3.8MiB but SILENTLY
		// truncates the resource there (probe-acp-frame 2026-11-24: a 4MiB
		// block reported "truncated at 4002908 bytes"), so anything in the
		// 3MiB..32MiB band would checkpoint content agy never read.
		const under = new AcpHistorySync([user("hello", 1)], undefined);
		expect(under.inputFor({ prompt: "x".repeat(2 * 1024 * 1024) }).prompt).toBeDefined();
		const sync = new AcpHistorySync([user("hello", 1)], undefined);
		const huge = "x".repeat(4 * 1024 * 1024);
		expect(() => sync.inputFor({ prompt: huge })).toThrow(/compact/i);
	});
});

describe("AcpHistorySync finish ordering", () => {
	const tr = (ts = 3000): Message => ({ role: "toolResult", toolCallId: "t1", toolName: "read", isError: false, content: [{ type: "text", text: "out" }], timestamp: ts });
	const request = [user("a", 1)];

	it("terminals an OK turn with the echo protocol", () => {
		const sync = new AcpHistorySync(request, undefined);
		const plan = sync.plan;
		sync.bound("t1");
		sync.dispatching();
		const a1 = assistant("reply", 2);
		sync.terminal(request, a1, "conv-1");
		const snap = sync.record();
		expect(snap.conversationId).toBe("conv-1");
		expect(snap.lastMessageCount).toBe(0);
		expect(snap.sync?.checkpoint).toEqual(historyCheckpoint(projectHistory(request)));
		expect(snap.sync?.expectedAssistantHash).toBe(semanticMessageHash(a1));
		expect(plan).toBeDefined();
	});

	it("parks with the request projection and resumes on the echo", () => {
		const sync = new AcpHistorySync(request, undefined);
		sync.bound("t1");
		sync.dispatching();
		const a1 = assistant("reply", 2);
		sync.park(request, a1);
		const echo = [user("a", 1), a1, tr()];
		const resumed = new AcpHistorySync(echo, { ...sync.record(), conversationId: "conv-1" }, { continuation: true });
		expect(resumed.plan.kind).toBe("resume");
	});

	it("aborted beats terminal: an aborted turn invalidates as interrupted", () => {
		const sync = new AcpHistorySync(request, undefined);
		sync.bound("t1");
		sync.dispatching();
		const a1 = { ...assistant("partial", 2), stopReason: "aborted" } as Message;
		const outcome = sync.finish({ ok: true, conversationId: "conv-1", promptAttempted: true, promptTerminal: true, aborted: true }, a1, request);
		expect(outcome).toMatchObject({ settled: "invalidated", reason: "interrupted" });
		expect(sync.record().sync?.invalidReason).toBe("interrupted");
	});

	it("marks delivery-unknown when the prompt was attempted but never terminal", () => {
		const sync = new AcpHistorySync(request, undefined);
		sync.bound("t1");
		sync.dispatching();
		const outcome = sync.finish({ ok: false, conversationId: "conv-1", promptAttempted: true, promptTerminal: false }, assistant("x", 2), request);
		expect(outcome).toMatchObject({ settled: "invalidated", reason: "delivery-unknown" });
	});

	it("marks unconfirmed-turn when the prompt never reached the transport", () => {
		const sync = new AcpHistorySync(request, undefined);
		sync.bound("t1");
		const outcome = sync.finish({ ok: false, conversationId: "conv-1", promptAttempted: false, promptTerminal: false }, assistant("x", 2), request);
		expect(outcome).toMatchObject({ settled: "invalidated", reason: "unconfirmed-turn" });
	});

	it("invalidates unexpected-session-change on a binding mismatch over a warm session", () => {
		const messages = [user("a", 1), assistant("r", 2), user("b", 3)];
		const projection = projectHistory(messages);
		const existing: AgySession = {
			conversationId: "conv-1",
			lastStepIdx: -1,
			lastMessageCount: 0,
			sync: { version: 1, epoch: 0, checkpoint: historyCheckpoint(projection, 2) },
		};
		const sync = new AcpHistorySync(messages, existing);
		sync.bound("t1");
		const outcome = sync.finish(
			{ ok: true, conversationId: "conv-other", promptAttempted: true, promptTerminal: true, aborted: false },
			assistant("r2", 4),
			[...messages, assistant("r2", 4)],
			"conv-1",
		);
		expect(outcome).toMatchObject({ settled: "invalidated", reason: "unexpected-session-change" });
	});

	it("adopts the binding when an unbound rebuild turn returns an id", () => {
		const sync = new AcpHistorySync(request, undefined);
		sync.bound("t1");
		const outcome = sync.finish({ ok: true, conversationId: "conv-new", promptAttempted: true, promptTerminal: true, aborted: false }, assistant("r", 2), request);
		expect(outcome).toMatchObject({ settled: "terminal" });
		expect(sync.record().conversationId).toBe("conv-new");
	});
});

describe("AcpHistorySync rebuild-over-record settling (round-7 B1)", () => {
	it("adopts the fresh conversation id instead of invalidating", () => {
		const existing: AgySession = {
			conversationId: "conv-stale",
			lastStepIdx: -1,
			lastMessageCount: 0,
		};
		const sync = new AcpHistorySync([user("a", 1), assistant("r", 2), user("again", 3)], existing);
		expect(sync.plan.kind).toBe("rebuild");
		expect(sync.boundConversationId).toBeNull();
		sync.bound("t1");
		sync.dispatching();
		const result = sync.finish({ ok: true, promptTerminal: true, conversationId: "conv-new" }, assistant("r2", 4), [
			user("a", 1),
			assistant("r", 2),
			user("again", 3),
			assistant("r2", 4),
		]);
		expect(result).toMatchObject({ settled: "terminal" });
		expect(sync.record().conversationId).toBe("conv-new");
	});

	it("write-ahead adoption via adoptBinding lands in the persisted record", () => {
		const sync = new AcpHistorySync([user("hello", 1)], undefined);
		sync.adoptBinding("conv-live");
		expect(sync.record().conversationId).toBe("conv-live");
	});

	it("loadFailed invalidates, re-plans as rebuild, and returns the complete input", () => {
		const projection = projectHistory([user("a", 1), assistant("r", 2), user("b", 3)]);
		const existing: AgySession = {
			conversationId: "conv-1",
			lastStepIdx: -1,
			lastMessageCount: 0,
			sync: { version: 1, epoch: 0, checkpoint: historyCheckpoint(projection, 2) },
		};
		const messages = [user("a", 1), assistant("r", 2), user("b", 3)];
		const sync = new AcpHistorySync(messages, existing);
		expect(sync.plan.kind).toBe("continue");
		const input = sync.loadFailed({ prompt: "PROMPT", images: [{ data: "p1", mimeType: "image/png" }] });
		expect(input.prompt).toBe("PROMPT");
		expect(input.images).toEqual([{ data: "p1", mimeType: "image/png" }]);
		expect(input.contextBlock?.uri).toBe("urn:pi-bridge:history:v1");
		expect(sync.plan.kind).toBe("rebuild");
		expect(sync.boundConversationId).toBeNull();
		// the recreated conversation re-binds and dispatches like any fresh turn
		sync.bound("t2");
		sync.dispatching();
		// the outcome of the recreated conversation is adopted, not a mismatch
		const result = sync.finish(
			{ ok: true, promptTerminal: true, conversationId: "conv-fresh" },
			assistant("r2", 5),
			[...messages, assistant("r2", 5)],
		);
		expect(result).toMatchObject({ settled: "terminal" });
		expect(sync.record().conversationId).toBe("conv-fresh");
	});
});

describe("AcpHistorySync finish classification (round-7 R4)", () => {
	it("invalidates unsettled-terminal when a confirmed turn settles without a binding", () => {
		const sync = new AcpHistorySync([user("hello", 1), assistant("r", 2)], undefined);
		const result = sync.finish(
			{ ok: true, promptTerminal: true, promptAttempted: true, conversationId: "conv-x" },
			assistant("r", 2),
			[user("hello", 1), assistant("r", 2)],
		);
		expect(result).toMatchObject({ settled: "invalidated", reason: "unsettled-terminal" });
	});

	it("classifies a terminal-but-failed outcome as unconfirmed-turn, not delivery-unknown", () => {
		const sync = new AcpHistorySync([user("hello", 1)], undefined);
		sync.bound("t1");
		sync.dispatching();
		const result = sync.finish(
			{ ok: false, promptTerminal: true, promptAttempted: true, conversationId: "conv-1" },
			assistant("r", 2),
			[user("hello", 1), assistant("r", 2)],
		);
		expect(result).toMatchObject({ settled: "invalidated", reason: "unconfirmed-turn" });
	});
});

describe("AcpHistorySync load-failure re-arm", () => {
	it("settleable again after loadFailed re-plans (the provider hook sequence)", () => {
		// The provider's onSessionLoadFailed must run bound+dispatching after
		// loadFailed: loadFailed leaves the phase syncing, and a settle
		// against a non-settleable coordinator forces a second rebuild.
		const request = [user("a", 1), assistant("r", 2), user("b", 3)];
		const sync = new AcpHistorySync(request, undefined);
		sync.bound("t1");
		sync.dispatching();
		const fresh = sync.loadFailed({ prompt: "retry" });
		expect(fresh.prompt).toBe("retry");
		sync.bound("t1");
		sync.dispatching();
		const result = sync.finish(
			{ ok: true, conversationId: "conv-fresh", promptAttempted: true, promptTerminal: true },
			assistant("reply", 4),
			request,
			"conv-old",
		);
		expect(result).toMatchObject({ settled: "terminal" });
		const snap = sync.record();
		expect(snap.conversationId).toBe("conv-fresh");
		expect(snap.sync?.checkpoint).toBeDefined();
	});
});
