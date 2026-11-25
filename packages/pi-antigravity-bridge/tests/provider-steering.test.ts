// Steering vs the park: a user message pi delivers into its context while an
// agy turn is parked on a bridge round-trip never reaches agy - the
// continuation pass re-attaches to the parked turn and sends no new user
// event, and pi's queue is already drained so nothing re-triggers. The
// transcript orders it [toolResult, user]; the model answers the pre-park
// work and the turn ends idle (Baluard session 2026-11-25 11:54:21). The
// provider must late-deliver those messages to agy after the parked turn
// ends, and hold the watermark when that delivery fails to start.
//
// Hardened against the round-2 review: the delivery floor is a per-session
// dispatch cursor, not the first-pending-toolResult anchor (a steer from an
// EARLIER park of a chain sits before the newer park's toolResult); the
// watermark hold also holds the boundary fingerprint; a steer leads a fresh
// dispatch when the parked turn is already gone; oversized steers are
// visibly truncated on stream-json (issue #2 silent drop).
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { normalizeContext, type Api, type AssistantMessage, type Message, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import {
	STREAM_JSON_PROMPT_MARGIN,
	STREAM_JSON_PROMPT_CAP,
	ToolRoundTrips,
	boundaryFingerprint,
	createStreamSimple,
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

const ENTRIES = [{ full: "gemini-3.6-flash", id: "gemini-flash" }];

/** Isolated cwd per test: the provider's steering cursor and the session
 *  record are keyed by `cwd:<cwd>`, so tests must not share a key. */
function tmpWorkspace(): { cwd: string; key: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-steer-"));
	return { cwd, key: `cwd:${cwd}` };
}

function stream(rtx: ToolRoundTrips, driver: StreamDriver, store: SessionStore, cwd: string, engine?: "stream-json" | "acp") {
	return createStreamSimple({
		entries: ENTRIES,
		store,
		driver,
		roundTrips: rtx,
		...(engine ? { engine } : {}),
	});
}

/** Fake driver: reentry() returns the live handle when liveReentry is set
 *  (model mid-turn on a parked bridge call); run() calls are recorded. The
 *  outcome conversation resolves at await time so tests can set it late. */
class RecordingDriver {
	seen: { opts?: DriverTurnRequest } = {};
	runCalls = 0;
	liveReentry = false;
	failRun = false;
	outcomeConv = "conv-fake";
	#handle() {
		return {
			id: "fake-turn",
			outcome: Promise.resolve().then(() => ({
				status: "OK" as const,
				response: "ok",
				finished: true,
				aborted: false,
				conversationId: this.outcomeConv,
			})),
			next: async (): Promise<DriverActivity | null> => null,
			pushExternal: (_a: DriverActivity) => {},
		};
	}
	get activeHandle() {
		return this.#handle();
	}
	kickIdle(): void {}
	reentry() {
		return this.liveReentry ? this.#handle() : null;
	}
	async run(opts: DriverTurnRequest) {
		if (this.failRun) throw new Error("boom");
		this.runCalls += 1;
		this.seen.opts = opts;
		return this.#handle();
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

function toolUseMessage(callId: string): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: "{}" }],
		timestamp: Date.now(),
	} as unknown as Message;
}

function userMessage(text: string, images?: Array<{ data: string; mimeType: string }>): Message {
	const content: Array<Record<string, string>> = [{ type: "text", text }];
	for (const img of images ?? []) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
	return { role: "user", content, timestamp: Date.now() } as unknown as Message;
}

async function drain(streamSimple: ReturnType<typeof createStreamSimple>, context: TranscriptContext, cwd: string): Promise<AssistantMessage[]> {
	const errors: AssistantMessage[] = [];
	const stream = streamSimple(model, context, { cwd } as unknown as SimpleStreamOptions);
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	return errors;
}

const STEER = "And amend the spaces if they are missing";

function rtFor(d: RecordingDriver, escalateAfterMs = 5_000): ToolRoundTrips {
	return new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs });
}

test("steering: a user message landing mid-park is delivered to agy after the parked turn ends", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.outcomeConv = "conv-b";
	const { cwd, key } = tmpWorkspace();
	const store = new SessionStore(path.join(cwd, "sessions.json"));
	const rt = rtFor(d);
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);
	rt.stampConversation("conv-b");

	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed to origin"), userMessage(STEER)],
	});
	const errors = await drain(stream(rt, d as unknown as StreamDriver, store, cwd), context, cwd);
	// The reentered parked turn settles without a run(); the steer is the
	// only late run, addressed to the conversation that was parked.
	assert.equal(d.runCalls, 1);
	assert.equal(d.seen.opts?.conversationId, "conv-b");
	assert.equal(d.seen.opts?.prompt, STEER);
	assert.equal(errors.length, 0);
	assert.equal(store.get(key)?.lastMessageCount, 2);
});

test("steering: a plain continuation without a user message starts no late run", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	const { cwd } = tmpWorkspace();
	const rt = rtFor(d);
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);

	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed to origin")],
	});
	const errors = await drain(stream(rt, d as unknown as StreamDriver, new SessionStore(path.join(cwd, "sessions.json")), cwd), context, cwd);
	assert.equal(d.runCalls, 0);
	assert.equal(errors.length, 0);
});

test("steering: image blocks ride the late delivery", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.outcomeConv = "conv-b";
	const { cwd } = tmpWorkspace();
	const rt = rtFor(d);
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);
	rt.stampConversation("conv-b");
	const IMG = { data: "aWNvbg==", mimeType: "image/png" };

	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed"), userMessage(STEER, [IMG])],
	});
	const errors = await drain(stream(rt, d as unknown as StreamDriver, new SessionStore(path.join(cwd, "sessions.json")), cwd), context, cwd);
	assert.equal(d.runCalls, 1);
	assert.deepEqual(d.seen.opts?.images, [IMG]);
	assert.equal(errors.length, 0);
});

test("steering: several steered messages join a single late prompt", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.outcomeConv = "conv-b";
	const { cwd } = tmpWorkspace();
	const rt = rtFor(d);
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);
	rt.stampConversation("conv-b");

	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed"), userMessage("first note"), userMessage(STEER)],
	});
	const errors = await drain(stream(rt, d as unknown as StreamDriver, new SessionStore(path.join(cwd, "sessions.json")), cwd), context, cwd);
	assert.equal(d.runCalls, 1);
	assert.equal(d.seen.opts?.prompt, `first note\n\n${STEER}`);
	assert.equal(errors.length, 0);
});

test("steering: a stranded escalated result and a steer combine into one late prompt", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.outcomeConv = "conv-b";
	const { cwd } = tmpWorkspace();
	const rt = rtFor(d, 30);
	const escalated = rt.onToolCall("c1", "ask_user_question", {}, new AbortController().signal);
	assert.deepEqual(await escalated, { escalated: true, callId: "c1", name: "ask_user_question" });
	rt.stampConversation("conv-b");

	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "USER ANSWER"), userMessage(STEER)],
	});
	const errors = await drain(stream(rt, d as unknown as StreamDriver, new SessionStore(path.join(cwd, "sessions.json")), cwd), context, cwd);
	assert.equal(d.runCalls, 1);
	const prompt = d.seen.opts?.prompt ?? "";
	assert.match(prompt, /Late tool delivery/);
	assert.match(prompt, /USER ANSWER/);
	assert.match(prompt, new RegExp(STEER));
	assert.equal(d.seen.opts?.conversationId, "conv-b");
	assert.equal(errors.length, 0);
});

test("steering: a failed late start holds the watermark and boundary so the digest re-offers the steer", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.failRun = true;
	d.outcomeConv = "conv-x";
	const { cwd, key } = tmpWorkspace();
	const store = new SessionStore(path.join(cwd, "sessions.json"));
	store.set(key, { conversationId: "conv-x", lastStepIdx: -1, lastMessageCount: 1 });
	const rt = rtFor(d);
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);

	const steerMsg = userMessage(STEER);
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed"), steerMsg],
	});
	const errors = await drain(stream(rt, d as unknown as StreamDriver, store, cwd), context, cwd);
	// The late run never started: the settle must not claim the steer, and
	// the held boundary must match the last claimed message or the next turn
	// misreads the transcript as mutated and resets the delta to full history.
	assert.equal(d.runCalls, 0);
	const rec = store.get(key);
	assert.ok(rec);
	assert.equal(rec.conversationId, "conv-x");
	assert.equal(rec.lastMessageCount, 1);
	const normalized = context.messages as Message[];
	assert.equal(rec.digestBoundary, boundaryFingerprint(normalized[0]));
	assert.equal(errors.length, 0);
});

test("steering: a steer from an earlier park of a chain is delivered on a later pass", async () => {
	const d = new RecordingDriver();
	d.outcomeConv = "conv-c";
	const { cwd, key } = tmpWorkspace();
	const store = new SessionStore(path.join(cwd, "sessions.json"));

	// Pass 0: the fresh dispatch that started the turn (prompt ends at index 1).
	const rt0 = rtFor(d);
	{
		const context: TranscriptContext = normalizeContext({
			systemPrompt: undefined,
			messages: [userMessage("remove the fingerprint from the footer")],
		});
		const errors = await drain(stream(rt0, d as unknown as StreamDriver, store, cwd), context, cwd);
		assert.equal(d.runCalls, 1);
		assert.equal(errors.length, 0);
	}
	assert.equal(store.get(key)?.lastMessageCount, 1);

	// Pass 2: the steer landed during the FIRST park (c1, already resolved
	// by its own earlier pass); c2 is the pending park this pass resolves.
	// The first-pending-toolResult anchor is c2's result, which sits AFTER
	// the steer - the dispatch cursor, not the anchor, must find it.
	d.liveReentry = true;
	const rt2 = rtFor(d);
	rt2.onToolCall("c2", "bash", {}, new AbortController().signal);
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [
			userMessage("remove the fingerprint from the footer"),
			toolUseMessage("c1"),
			toolResultMessage("c1", "pushed"),
			userMessage(STEER),
			toolUseMessage("c2"),
			toolResultMessage("c2", "pushed again"),
		],
	});
	const errors = await drain(stream(rt2, d as unknown as StreamDriver, store, cwd), context, cwd);
	assert.equal(d.runCalls, 2);
	assert.equal(d.seen.opts?.prompt, STEER);
	assert.equal(d.seen.opts?.conversationId, "conv-c");
	assert.equal(errors.length, 0);
	// The steer reached agy before the settle: the record claims the tail.
	assert.equal(store.get(key)?.lastMessageCount, 6);
});

test("steering: a steer leads the fresh dispatch when the parked turn is already gone", async () => {
	const d = new RecordingDriver();
	d.outcomeConv = "conv-d";
	const { cwd, key } = tmpWorkspace();
	const store = new SessionStore(path.join(cwd, "sessions.json"));
	store.set(key, { conversationId: "conv-d", lastStepIdx: -1, lastMessageCount: 1 });
	const rt = rtFor(d);
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);

	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed"), userMessage(STEER)],
	});
	const errors = await drain(stream(rt, d as unknown as StreamDriver, store, cwd), context, cwd);
	// No live turn to re-enter: the steer becomes the fresh dispatch's own
	// prompt against the bound conversation instead of an error stop.
	assert.equal(d.runCalls, 1);
	assert.equal(d.seen.opts?.prompt, STEER);
	assert.equal(d.seen.opts?.conversationId, "conv-d");
	assert.equal(errors.length, 0);
	assert.equal(store.get(key)?.lastMessageCount, 2);
});

test("steering: an oversized steer is visibly truncated on stream-json", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.outcomeConv = "conv-s";
	const { cwd } = tmpWorkspace();
	const rt = rtFor(d);
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);
	rt.stampConversation("conv-s");
	const big = "y".repeat(STREAM_JSON_PROMPT_CAP + 8_192);

	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed"), userMessage(big)],
	});
	const errors = await drain(stream(rt, d as unknown as StreamDriver, new SessionStore(path.join(cwd, "sessions.json")), cwd, "stream-json"), context, cwd);
	assert.equal(d.runCalls, 1);
	const prompt = d.seen.opts?.prompt ?? "";
	assert.match(prompt, /^\[truncated\]/);
	assert.ok(Buffer.byteLength(prompt, "utf8") <= STREAM_JSON_PROMPT_CAP - STREAM_JSON_PROMPT_MARGIN);
	assert.equal(errors.length, 0);
});
