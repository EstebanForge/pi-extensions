// Early-ack + poll: slow bridge calls must not hold the tools/call HTTP
// request past agy's ~180s MCP client deadline. onToolCall settles with a
// BridgeEscalation sentinel after ~20s; the bridge answers with a poll
// handle while pi keeps executing, and the result reaches agy through
// bridge_poll_result (or the late-delivery path when agy never polls).
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { normalizeContext, type Api, type AssistantMessage, type Message, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import {
	DELEGATION_ESCALATE_MS,
	ESCALATE_AFTER_MS,
	EscalationRegistry,
	POLL_TOOL_NAME,
	ToolRoundTrips,
	collectToolResults,
	createStreamSimple,
	defaultEscalateAfterMs,
	formatEscalatedAck,
	formatPollAnswer,
	type BridgeCallResultShape,
} from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { StreamDriver, DriverActivity, DriverTurnRequest } from "../src/driver.js";

const model: Model<Api> = {
	id: "gemini-flash",
	name: "Gemini 3.6 Flash (Medium)",
	api: "agy-bridge" as Api,
	provider: "antigravity",
	baseUrl: "agy-bridge://antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-esc-")), "sessions.json");
}

const ESC = 30; // ms; fast escalation for tests

/** Fake driver: active handle for parks, null reentry (no live agy turn),
 *  recorded run() calls. Cast keeps the TurnDriver surface loose. */
class RecordingDriver {
	seen: { opts?: DriverTurnRequest } = {};
	runCalls = 0;
	/** When true, reentry() returns the live handle (model mid-turn). */
	liveReentry = false;
	/** When true, run() throws (driver start failure). */
	failRun = false;
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
		return this.liveReentry ? this.#handle : null;
	}
	async run(opts: DriverTurnRequest) {
		if (this.failRun) throw new Error("boom");
		this.runCalls += 1;
		this.seen.opts = opts;
		return this.#handle;
	}
}

function toolResultMessage(callId: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: callId,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as unknown as Message;
}

test("escalation: fast calls settle with the real result and never register a handle", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: 5_000 });
	const p = rt.onToolCall("c1", "read", {}, new AbortController().signal);
	assert.equal(rt.resolve("c1", "file body", false), true);
	const res = (await p) as BridgeCallResultShape;
	assert.equal("escalated" in res, false);
	assert.equal(res.isError, false);
	assert.equal(res.content[0].text, "file body");
	assert.equal(rt.poll("c1"), undefined);
});

test("escalation: slow calls settle with a sentinel, poll reports running then the result", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	const p = rt.onToolCall("c1", "AskClaude", {}, new AbortController().signal);
	const res = await p;
	assert.deepEqual(res, { escalated: true, callId: "c1", name: "AskClaude" });

	const running = rt.poll("c1");
	assert.ok(running);
	assert.equal(running.state, "running");
	assert.equal(running.name, "AskClaude");

	assert.equal(rt.resolve("c1", "REVIEW OUTPUT", false), true);
	const done = rt.poll("c1");
	assert.ok(done);
	assert.equal(done.state, "done");
	assert.equal(done.text, "REVIEW OUTPUT");
	assert.equal(done.isError, false);
	// No tombstone: nothing failed, the late-delivery path must not fire.
	assert.deepEqual(rt.deadIds, []);
});

test("escalation: delegation-shaped tools escalate later by default (issue #6)", () => {
	// 120s holds the synchronous window across the 30-120s subagent range
	// while staying under agy's ~180s tools/call abandonment.
	assert.equal(defaultEscalateAfterMs("subagent_run"), DELEGATION_ESCALATE_MS);
	assert.equal(defaultEscalateAfterMs("agent_spawn"), DELEGATION_ESCALATE_MS);
	assert.equal(defaultEscalateAfterMs("agent_wait"), DELEGATION_ESCALATE_MS);
	// Claude Code-style exact names (tintinweb pi-subagents registers "Agent").
	assert.equal(defaultEscalateAfterMs("Agent"), DELEGATION_ESCALATE_MS);
	assert.equal(defaultEscalateAfterMs("agent"), DELEGATION_ESCALATE_MS);
	// Ordinary and human-gated tools keep the fast ack: the poll path is
	// load-bearing for permission flows.
	assert.equal(defaultEscalateAfterMs("read"), ESCALATE_AFTER_MS);
	assert.equal(defaultEscalateAfterMs("ask_user_question"), ESCALATE_AFTER_MS);
	assert.equal(defaultEscalateAfterMs("bridge_poll_result"), ESCALATE_AFTER_MS);
	// The agent stem is start-anchored: incidental agent_ substrings elsewhere
	// in a name keep the fast ack.
	assert.equal(defaultEscalateAfterMs("user_agent_lookup"), ESCALATE_AFTER_MS);
	assert.equal(defaultEscalateAfterMs("pageagent"), ESCALATE_AFTER_MS);
	// Config-listed names join the long class.
	assert.equal(defaultEscalateAfterMs("db_benchmark", ["db_benchmark"]), DELEGATION_ESCALATE_MS);
});

test("escalation: per-call resolver gives delegation and ordinary tools different clocks", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, {
		escalateAfterMs: (name) => (name === "subagent_run" ? 120 : 20),
	});
	const slow = rt.onToolCall("c1", "subagent_run", {}, new AbortController().signal);
	const fast = rt.onToolCall("c2", "read", {}, new AbortController().signal);
	await new Promise((r) => setTimeout(r, 60));
	// Ordinary tool escalated at 20ms; the delegation call still holds its
	// synchronous window (no poll handle yet).
	assert.equal(rt.poll("c2")?.state, "running");
	assert.equal(rt.poll("c1"), undefined);
	assert.deepEqual(await fast, { escalated: true, callId: "c2", name: "read" });
	assert.deepEqual(await slow, { escalated: true, callId: "c1", name: "subagent_run" });
});

test("escalation: escalateAfterMs 0 disables the early ack entirely", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: 0 });
	const p = rt.onToolCall("c1", "AskClaude", {}, new AbortController().signal);
	rt.resolve("c1", "DONE", false);
	const res = (await p) as BridgeCallResultShape;
	assert.equal("escalated" in res, false);
	assert.equal(rt.poll("c1"), undefined);
});

test("escalation: aborted escalated calls report through poll AND keep the tombstone backstop", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	const ctrl = new AbortController();
	const settled = rt
		.onToolCall("c1", "exec_command", {}, ctrl.signal)
		.then((r) => ("escalated" in r ? "escalated" : "resolved"), () => "rejected");
	await new Promise((r) => setTimeout(r, ESC + 20));
	assert.equal(await settled, "escalated");
	// User aborts the pi tool: a REAL failure. The abort path must reach both
	// the poll handle and the late-delivery tombstone.
	ctrl.abort();
	const view = rt.poll("c1");
	assert.ok(view);
	assert.equal(view.state, "failed");
	assert.match(view.reason ?? "", /agy disconnected/);
	assert.deepEqual(rt.deadIds, ["c1"]);
});

test("escalation: failAll spares escalated calls (turn end must not fake a failure)", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	const p = rt.onToolCall("c1", "AskClaude", {}, new AbortController().signal);
	await p; // sentinel: escalated, pi tool still executing
	// extensions/index.ts fires exactly this on EVERY turn end, OK turns
	// included. An escalated call outlives the turn by design; failing it
	// here would make bridge_poll_result lie about a still-running tool.
	rt.failAll("antigravity turn ended with an unresolved pi tool call");
	const running = rt.poll("c1");
	assert.ok(running);
	assert.equal(running.state, "running");
	assert.deepEqual(rt.pendingIds, ["c1"]);
	// It still settles normally when the tool finishes.
	assert.equal(rt.resolve("c1", "REVIEW OUTPUT", false), true);
	const done = rt.poll("c1");
	assert.ok(done);
	assert.equal(done.state, "done");
});

test("escalation: unpolled result with a dead agy turn is re-delivered as a late prompt", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	const p = rt.onToolCall("call-1", "ask_user_question", {}, new AbortController().signal);
	await p; // sentinel: escalated; the model ended its turn instead of polling
	// Turn end: the extension stamps live escalations with the conversation id
	// (first-turn parks never reach the provider's store.set).
	rt.stampConversation("conv-9");

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("call-1", "USER ANSWER")],
	});
	const errors: AssistantMessage[] = [];
	const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	// The strand is gone: the answer reaches agy as a late prompt in the SAME
	// conversation, not a quiet settle into a registry nobody polls.
	assert.equal(errors.length, 0);
	assert.equal(d.runCalls, 1);
	const prompt = d.seen.opts?.prompt ?? "";
	assert.match(prompt, /Late tool delivery/);
	assert.match(prompt, /USER ANSWER/);
	assert.match(prompt, /without calling bridge_poll_result/);
	// The framing must name the tool (issue #7): a bare result reads as a
	// random follow-up prompt.
	assert.match(prompt, /pi tool "ask_user_question":/);
	assert.equal(d.seen.opts?.conversationId, "conv-9");
	// The entry stays pollable for a late model poll; the claim is single-use.
	assert.equal(rt.poll("call-1")?.state, "done");
	assert.equal(rt.claimUndelivered("call-1"), undefined);
});

test("escalation: two stranded results in one pass redeliver in a single late prompt", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	await rt.onToolCall("c1", "ask_user_question", {}, new AbortController().signal);
	await rt.onToolCall("c2", "git_commit", {}, new AbortController().signal);
	rt.stampConversation("conv-m");

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "ANSWER ONE"), toolResultMessage("c2", "COMMIT SHA")],
	});
	const errors: AssistantMessage[] = [];
	const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	assert.equal(errors.length, 0);
	assert.equal(d.runCalls, 1);
	const prompt = d.seen.opts?.prompt ?? "";
	assert.match(prompt, /ANSWER ONE/);
	assert.match(prompt, /COMMIT SHA/);
	assert.match(prompt, /pi tool "ask_user_question":/);
	assert.match(prompt, /pi tool "git_commit":/);
	assert.equal(d.seen.opts?.conversationId, "conv-m");
});

test("escalation: unbindable conversation settles quietly and releases the claims", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	// c1: stranded in an earlier pass (pending entry consumed by resolve).
	await rt.onToolCall("c1", "ask_user_question", {}, new AbortController().signal);
	rt.resolve("c1", "STRANDED ANSWER", false);
	// c2: escalated and still pending; its result anchors the pass.
	await rt.onToolCall("c2", "git_commit", {}, new AbortController().signal);

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c2", "COMMIT SHA")],
	});
	const errors: AssistantMessage[] = [];
	const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	// No stamp, no store record: a late prompt would hit a brand-new
	// conversation that never asked. Quiet settle; claims are released so a
	// later pass with a bound conversation can still sweep them.
	assert.equal(errors.length, 0);
	assert.equal(d.runCalls, 0);
	assert.ok(rt.claimUndelivered("c1"));
	assert.ok(rt.claimUndelivered("c2"));
});

test("escalation: a strand from an earlier pass is swept on the next fresh pass", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	await rt.onToolCall("c1", "ask_user_question", {}, new AbortController().signal);
	rt.resolve("c1", "STRANDED ANSWER", false);
	// No tombstone, no pending id: only the registry sweep can find it.
	assert.deepEqual(rt.deadIds, []);
	assert.deepEqual(rt.pendingIds, []);

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [{ role: "user", content: "continue", timestamp: Date.now() } as unknown as Message],
	});
	const errors: AssistantMessage[] = [];
	const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	assert.equal(errors.length, 0);
	assert.equal(d.runCalls, 1);
	assert.match(d.seen.opts?.prompt ?? "", /STRANDED ANSWER/);
	assert.match(d.seen.opts?.prompt ?? "", /continue/);
});

test("escalation: a failed redelivery run releases its claims for the next pass", async () => {
	const d = new RecordingDriver();
	d.failRun = true;
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	await rt.onToolCall("c1", "ask_user_question", {}, new AbortController().signal);
	rt.stampConversation("conv-x");

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "USER ANSWER")],
	});
	const errors: AssistantMessage[] = [];
	const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	assert.equal(errors.length, 1);
	assert.equal(d.runCalls, 0);
	// The claim came back: the next pass can retry the delivery.
	assert.ok(rt.claimUndelivered("c1"));
});

test("escalation: live turn that ends without polling redelivers after outcome", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	const p = rt.onToolCall("c1", "ask_user_question", {}, new AbortController().signal);
	await p; // escalated; the answer lands while the model is still mid-turn
	rt.stampConversation("conv-b");

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "LATE ANSWER")],
	});
	const errors: AssistantMessage[] = [];
	const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	// The reentered live turn re-attaches WITHOUT a run() (it was started by
	// an earlier pass); the post-outcome redelivery is the only run here.
	assert.equal(d.runCalls, 1);
	const prompt = d.seen.opts?.prompt ?? "";
	assert.match(prompt, /Late tool delivery/);
	assert.match(prompt, /LATE ANSWER/);
	assert.match(prompt, /pi tool "ask_user_question":/);
	assert.equal(d.seen.opts?.conversationId, "conv-b");
	assert.equal(errors.length, 0);
});

test("escalation: delivered tracking is terminal-only, single-use, and poll stays pure", () => {
	const reg = new EscalationRegistry();
	reg.escalate("c1", "tool");
	// A running call cannot be marked: only a terminal result counts as read.
	assert.equal(reg.markDelivered("c1"), false);
	reg.settleDone("c1", "out", false);
	// The provider's escalatedNames peek must not mark anything delivered.
	assert.equal(reg.poll("c1")?.delivered ?? false, false);
	assert.equal(reg.markDelivered("c1"), true);
	assert.equal(reg.claimUndelivered("c1"), undefined);

	reg.escalate("c2", "tool");
	reg.settleDone("c2", "out2", false);
	const v = reg.claimUndelivered("c2");
	assert.ok(v);
	assert.equal(v.text, "out2");
	assert.equal(reg.claimUndelivered("c2"), undefined);
	// The entry is kept: a late model poll still gets the result.
	assert.equal(reg.poll("c2")?.state, "done");
	assert.equal(reg.poll("c2")?.text, "out2");

	// Registry-wide sweep: done-only, single-use; unclaim restores.
	reg.escalate("c3", "tool");
	reg.settleDone("c3", "out3", false);
	assert.deepEqual(reg.claimAllUndelivered().map((x) => x.callId), ["c3"]);
	assert.deepEqual(reg.claimAllUndelivered(), []);
	reg.unclaim("c3"); // delivery failed to start: back to the pool
	assert.ok(reg.claimUndelivered("c3"));
	// Failed escalations stay with the tombstone path, never the sweep.
	reg.escalate("c4", "tool");
	reg.settleFailed("c4", "boom");
	assert.deepEqual(reg.claimAllUndelivered(), []);
	assert.equal(reg.claimUndelivered("c4"), undefined);
	// Everything is claimed, delivered, or failed now: the sweep is empty.
	assert.deepEqual(reg.claimAllUndelivered(), []);
});

test("escalation: stampConversation marks only running entries", () => {
	const reg = new EscalationRegistry();
	reg.escalate("live", "tool");
	reg.escalate("settled", "tool");
	reg.settleDone("settled", "x", false);
	reg.stampConversation("conv-1");
	assert.equal(reg.poll("live")?.conversationId, "conv-1");
	assert.equal(reg.poll("settled")?.conversationId, undefined);
	// First stamp wins: the ended turn that owned the call fixes the route;
	// a later turn-end must not re-route a still-running delivery.
	reg.stampConversation("conv-2");
	assert.equal(reg.poll("live")?.conversationId, "conv-1");
	// A call that escalates after the stamp belongs to a later turn.
	reg.escalate("fresh", "tool");
	assert.equal(reg.poll("fresh")?.conversationId, undefined);
});

test("escalation: ack and poll answers are model-readable", () => {
	const ack = formatEscalatedAck({ escalated: true, callId: "abc-1", name: "AskClaude" });
	assert.equal(ack.isError, false);
	const ackText = ack.content[0].text ?? "";
	assert.match(ackText, /STILL RUNNING/);
	assert.match(ackText, /AskClaude/);
	assert.match(ackText, /abc-1/);
	assert.match(ackText, new RegExp(POLL_TOOL_NAME));
	// Hardened contract: polling is mandatory. The old ack licensed stopping
	// ("if you stop polling, the bridge re-delivers the result in a later
	// turn") and gemini took the exit, stranding an ask_user_question answer.
	assert.match(ackText, /Do NOT end your turn/);
	assert.match(ackText, /strands the result/);
	assert.doesNotMatch(ackText, /re-delivers the result in a later turn/);

	const unknown = formatPollAnswer("nope", undefined);
	assert.equal(unknown.isError, true);
	const running = formatPollAnswer("abc-1", { state: "running", name: "AskClaude" });
	assert.match(running.content[0].text ?? "", /STILL RUNNING/);
	assert.equal(running.isError, false);
	const failed = formatPollAnswer("abc-1", { state: "failed", name: "AskClaude", reason: "boom" });
	assert.equal(failed.isError, true);
	assert.match(failed.content[0].text ?? "", /boom/);
	const done = formatPollAnswer("abc-1", { state: "done", name: "AskClaude", text: "the answer", isError: false });
	assert.equal(done.isError, false);
	assert.equal(done.content[0].text, "the answer");
});

test("escalation: registry soft cap never evicts running entries", () => {
	const reg = new EscalationRegistry();
	for (let i = 0; i < 70; i++) reg.escalate(`c${i}`, "tool");
	// Saturating the cap with in-flight calls grows the map instead of
	// stranding a running result (settle on an evicted id is a no-op).
	assert.ok(reg.poll("c0"));
	assert.equal(reg.poll("c0")?.state, "running");
	// Only settled entries evict, oldest first.
	reg.settleDone("c0", "out", false);
	reg.escalate("c70", "tool");
	assert.equal(reg.poll("c0"), undefined);
	assert.equal(reg.poll("c1")?.state, "running");
	assert.equal(reg.poll("c70")?.state, "running");
	assert.equal(reg.poll("missing"), undefined);
});

// --- image blocks over the bridge (ACP engine) ---------------------------------

const IMG = { data: "aWNvbg==", mimeType: "image/png" };

function toolResultImageMessage(callId: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: callId,
		content: [
			{ type: "text", text },
			{ type: "image", data: IMG.data, mimeType: IMG.mimeType },
			// Malformed entries must be dropped, not forwarded.
			{ type: "image", mimeType: "image/jpeg" },
			{ type: "image", data: "", mimeType: "image/png" },
			{ type: "thinking", thinking: "x" },
		],
		isError: false,
		timestamp: Date.now(),
	} as unknown as Message;
}

test("bridge images: collectToolResults extracts image blocks from parked tool results", () => {
	const msgs = [toolResultImageMessage("c1", "Read image file [image/png]")];
	const out = collectToolResults(msgs, ["c1"]);
	assert.equal(out.length, 1);
	assert.equal(out[0].text, "Read image file [image/png]");
	assert.deepEqual(out[0].images, [IMG]);
	// No images on plain results; unknown ids never surface.
	assert.deepEqual(collectToolResults([toolResultMessage("c2", "txt")], ["c2"])[0].images, []);
});

test("bridge images: fast (non-escalated) resolve emits image content ahead of text", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: 5_000 });
	const p = rt.onToolCall("c1", "read", {}, new AbortController().signal);
	rt.resolve("c1", "Read image file [image/png]", false, [IMG]);
	const res = (await p) as BridgeCallResultShape;
	assert.equal(res.isError, false);
	assert.deepEqual(res.content[0], { type: "image", data: IMG.data, mimeType: IMG.mimeType });
	assert.equal(res.content[1].text, "Read image file [image/png]");
});

test("bridge images: escalated resolve carries images through poll and formatPollAnswer", () => {
	const reg = new EscalationRegistry();
	reg.escalate("c1", "read");
	reg.settleDone("c1", "Read image file [image/png]", false, [IMG]);
	const view = reg.poll("c1");
	assert.ok(view);
	assert.deepEqual(view.images, [IMG]);
	const res = formatPollAnswer("c1", view);
	assert.equal(res.isError, false);
	assert.deepEqual(res.content[0], { type: "image", data: IMG.data, mimeType: IMG.mimeType });
	assert.equal(res.content[1].text, "Read image file [image/png]");
});

// The engine gate lives at the runTurnDriver resolve call site, not in
// ToolRoundTrips: drive a real continuation through createStreamSimple to
// pin it. Deleting or inverting the ternary must turn these red.
async function driveContinuation(engine: "stream-json" | "acp"): Promise<BridgeCallResultShape> {
	// Two DISTINCT stubs: createStreamSimple labels the engine by object
	// identity (selected === deps.acpDriver), so a shared instance would
	// mislabel the stream-json run as acp.
	const dStream = new RecordingDriver();
	const dAcp = new RecordingDriver();
	const rt = new ToolRoundTrips(dStream as unknown as StreamDriver, undefined, { escalateAfterMs: 5_000 });
	const p = rt.onToolCall("c1", "read", {}, new AbortController().signal);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver: dStream as unknown as StreamDriver,
		acpDriver: dAcp as unknown as StreamDriver,
		roundTrips: rt,
		engine,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultImageMessage("c1", "Read image file [image/png]")],
	});
	const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
	for await (const _ev of stream) {
		// Drain: the parked promise settles inside the continuation pass; the
		// post-resolve branch may finalize an error (no live turn to re-enter).
	}
	return (await p) as BridgeCallResultShape;
}

test("bridge images: forwarded on stream-json (probe 2026-09-07: transport delivers pixels)", async () => {
	const res = await driveContinuation("stream-json");
	assert.deepEqual(res.content, [
		{ type: "image", data: IMG.data, mimeType: IMG.mimeType },
		{ type: "text", text: "Read image file [image/png]" },
	]);
});

test("bridge images: engine gate forwards pixels on acp", async () => {
	const res = await driveContinuation("acp");
	assert.deepEqual(res.content, [
		{ type: "image", data: IMG.data, mimeType: IMG.mimeType },
		{ type: "text", text: "Read image file [image/png]" },
	]);
});
