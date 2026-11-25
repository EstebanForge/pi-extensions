// Steering vs the park: a user message pi delivers into its context while an
// agy turn is parked on a bridge round-trip never reaches agy - the
// continuation pass re-attaches to the parked turn and sends no new user
// event, and pi's queue is already drained so nothing re-triggers. The
// transcript orders it [toolResult, user]; the model answers the pre-park
// work and the turn ends idle (Baluard session 2026-11-25 11:54:21). The
// provider must late-deliver those messages to agy after the parked turn
// ends, and hold the watermark when that delivery fails to start.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { normalizeContext, type Api, type AssistantMessage, type Message, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { ToolRoundTrips, createStreamSimple } from "../src/provider.js";
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

function tmpStore(): SessionStore {
	return new SessionStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-steer-")), "sessions.json"));
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

function userMessage(text: string, images?: Array<{ data: string; mimeType: string }>): Message {
	const content: Array<Record<string, string>> = [{ type: "text", text }];
	for (const img of images ?? []) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
	return { role: "user", content, timestamp: Date.now() } as unknown as Message;
}

async function drain(streamSimple: ReturnType<typeof createStreamSimple>, context: TranscriptContext): Promise<AssistantMessage[]> {
	const errors: AssistantMessage[] = [];
	const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	return errors;
}

const STEER = "And amend the spaces if they are missing";

test("steering: a user message landing mid-park is delivered to agy after the parked turn ends", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.outcomeConv = "conv-b";
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: 5_000 });
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);
	rt.stampConversation("conv-b");

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: tmpStore(),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed to origin"), userMessage(STEER)],
	});
	const errors = await drain(streamSimple, context);
	// The reentered parked turn settles without a run(); the steer is the
	// only late run, addressed to the conversation that was parked.
	assert.equal(d.runCalls, 1);
	assert.equal(d.seen.opts?.conversationId, "conv-b");
	assert.equal(d.seen.opts?.prompt, STEER);
	assert.equal(errors.length, 0);
});

test("steering: a plain continuation without a user message starts no late run", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.outcomeConv = "conv-b";
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: 5_000 });
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: tmpStore(),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed to origin")],
	});
	const errors = await drain(streamSimple, context);
	assert.equal(d.runCalls, 0);
	assert.equal(errors.length, 0);
});

test("steering: image blocks ride the late delivery", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.outcomeConv = "conv-b";
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: 5_000 });
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);
	rt.stampConversation("conv-b");
	const IMG = { data: "aWNvbg==", mimeType: "image/png" };

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: tmpStore(),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed"), userMessage(STEER, [IMG])],
	});
	const errors = await drain(streamSimple, context);
	assert.equal(d.runCalls, 1);
	assert.deepEqual(d.seen.opts?.images, [IMG]);
	assert.equal(errors.length, 0);
});

test("steering: several steered messages join a single late prompt", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.outcomeConv = "conv-b";
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: 5_000 });
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);
	rt.stampConversation("conv-b");

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: tmpStore(),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed"), userMessage("first note"), userMessage(STEER)],
	});
	const errors = await drain(streamSimple, context);
	assert.equal(d.runCalls, 1);
	assert.equal(d.seen.opts?.prompt, `first note\n\n${STEER}`);
	assert.equal(errors.length, 0);
});

test("steering: a stranded escalated result and a steer combine into one late prompt", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.outcomeConv = "conv-b";
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: 30 });
	const escalated = rt.onToolCall("c1", "ask_user_question", {}, new AbortController().signal);
	assert.deepEqual(await escalated, { escalated: true, callId: "c1", name: "ask_user_question" });
	rt.stampConversation("conv-b");

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: tmpStore(),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "USER ANSWER"), userMessage(STEER)],
	});
	const errors = await drain(streamSimple, context);
	assert.equal(d.runCalls, 1);
	const prompt = d.seen.opts?.prompt ?? "";
	assert.match(prompt, /Late tool delivery/);
	assert.match(prompt, /USER ANSWER/);
	assert.match(prompt, new RegExp(STEER));
	assert.equal(d.seen.opts?.conversationId, "conv-b");
	assert.equal(errors.length, 0);
});

test("steering: a failed late start holds the watermark so the digest re-offers the steer", async () => {
	const d = new RecordingDriver();
	d.liveReentry = true;
	d.failRun = true;
	d.outcomeConv = "conv-x";
	const store = tmpStore();
	const key = `cwd:${process.cwd()}`;
	store.set(key, { conversationId: "conv-x", lastStepIdx: -1, lastMessageCount: 1 });
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: 5_000 });
	rt.onToolCall("c1", "bash", {}, new AbortController().signal);

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("c1", "pushed"), userMessage(STEER)],
	});
	const errors = await drain(streamSimple, context);
	// The late run never started: the settle must not claim the steer.
	assert.equal(d.runCalls, 0);
	const rec = store.get(key);
	assert.ok(rec);
	assert.equal(rec.conversationId, "conv-x");
	assert.equal(rec.lastMessageCount, 1);
	assert.equal(errors.length, 0);
});
