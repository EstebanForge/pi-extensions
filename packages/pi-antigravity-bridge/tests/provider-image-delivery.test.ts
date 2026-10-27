// Image delivery through streamSimple: user-attached image blocks on the
// stream-json engine (staged to temp files, prompt names the paths), native
// passthrough on ACP, and image-bearing late/stranded redeliveries (the
// model never polled, so the pixels must ride the next driver.run).
//
// Regression source: 2026-10-22 couch session — gemini-3.8-flash read a
// screenshot, the park escalated, the model never called bridge_poll_result,
// and the stranded redelivery carried text only, so the image never reached
// it (it fell back to hunting OCR libraries).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	normalizeContext,
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ToolRoundTrips, createStreamSimple } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { StreamDriver, DriverActivity, DriverTurnRequest } from "../src/driver.js";

const model: Model<Api> = {
	id: "gemini-flash",
	name: "Gemini 3.8 Flash (Medium)",
	api: "agy-bridge" as Api,
	provider: "antigravity",
	baseUrl: "agy-bridge://antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

const IMG = { data: Buffer.from("png-pixels-0").toString("base64"), mimeType: "image/png" };

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-imgdeliv-")), "sessions.json");
}

function fakeDriver(seen: { opts?: DriverTurnRequest }) {
	const fakeHandle = {
		id: "fake-turn",
		outcome: Promise.resolve({ status: "OK" as const, response: "ok", finished: true, aborted: false }),
		next: async (): Promise<DriverActivity | null> => null,
		pushExternal: (_a: DriverActivity) => {},
	};
	return {
		get activeHandle() {
			return fakeHandle;
		},
		kickIdle: () => {},
		reentry: () => null,
		run: async (opts: DriverTurnRequest) => {
			seen.opts = opts;
			return fakeHandle;
		},
	} as unknown as StreamDriver;
}

function userMessageWithImage(): Message {
	return {
		role: "user",
		content: [
			{ type: "text", text: "what does this say?" },
			{ type: "image", data: IMG.data, mimeType: IMG.mimeType },
		],
		timestamp: Date.now(),
	} as unknown as Message;
}

function toolResultMessage(callId: string, text: string, withImage = false): Message {
	const content: Array<Record<string, unknown>> = [{ type: "text", text }];
	if (withImage) content.unshift({ type: "image", data: IMG.data, mimeType: IMG.mimeType });
	return {
		role: "toolResult",
		toolCallId: callId,
		content,
		isError: false,
		timestamp: Date.now(),
	} as unknown as Message;
}

function makeStreamSimple(
	driver: StreamDriver,
	rt: ToolRoundTrips,
	engine?: "stream-json" | "acp",
) {
	return createStreamSimple({
		entries: [{ full: "gemini-3.8-flash-high", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver,
		// The inner engine label is by object identity (selected ===
		// acpDriver), so an acp run needs the same stub in both slots.
		...(engine === "acp" ? { acpDriver: driver } : {}),
		roundTrips: rt,
		...(engine ? { engine } : {}),
	});
}

async function collect(stream: ReturnType<ReturnType<typeof createStreamSimple>>): Promise<AssistantMessage[]> {
	const errors: AssistantMessage[] = [];
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	return errors;
}

test("stream-json: user image blocks stage to disk and the prompt names the paths", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = fakeDriver(seen);
	const rt = new ToolRoundTrips(driver);
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [userMessageWithImage()],
	});
	const errors = await collect(makeStreamSimple(driver, rt)(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions));
	assert.equal(errors.length, 0);
	assert.ok(seen.opts, "driver.run was called");
	assert.match(seen.opts.prompt, /pi-bridge-img-/);
	assert.match(seen.opts.prompt, /read tool/i);
	const staged = seen.opts.prompt.match(/(\/[^\s]*pi-bridge-img-[^\s]*image-1\.png)/);
	assert.ok(staged, "prompt carries the staged path");
	assert.deepEqual(fs.readFileSync(staged[1]), Buffer.from("png-pixels-0"));
});

test("acp: user image blocks ride request.images with no staging note", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = fakeDriver(seen);
	const rt = new ToolRoundTrips(driver);
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [userMessageWithImage()],
	});
	const errors = await collect(makeStreamSimple(driver, rt, "acp")(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions));
	assert.equal(errors.length, 0);
	assert.ok(seen.opts);
	assert.deepEqual(seen.opts.images, [IMG]);
	assert.equal(seen.opts.prompt.includes("pi-bridge-img-"), false);
});

test("late delivery: a tombstoned image result redelivers its image", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = fakeDriver(seen);
	const rt = new ToolRoundTrips(driver);
	const settled = rt
		.onToolCall("call-1", "read", { path: "/tmp/shot.png" }, new AbortController().signal)
		.then(
			() => "resolved",
			() => "rejected",
		);
	rt.failAll("agy disconnected before the tool result arrived");
	await settled;
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [toolResultMessage("call-1", "Read image file [image/png]", true)],
	});
	const errors = await collect(makeStreamSimple(driver, rt, "acp")(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions));
	assert.equal(errors.length, 0);
	assert.ok(seen.opts);
	assert.match(seen.opts.prompt, /Late tool delivery/);
	assert.deepEqual(seen.opts.images, [IMG]);
});

test("stranded escalated image result redelivers via a new prompt carrying the image", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = fakeDriver(seen);
	const rt = new ToolRoundTrips(driver, undefined, { escalateAfterMs: 5 });
	const parked = rt.onToolCall("call-9", "read", { path: "/tmp/shot.png" }, new AbortController().signal);
	await new Promise((r) => setTimeout(r, 20));
	const ack = await parked;
	assert.ok(typeof ack === "object" && "escalated" in ack, "call escalated");
	// The owning turn ends without a poll: stamp the conversation, then the
	// result settles in the registry with its image.
	rt.stampConversation("conv-1");
	rt.resolve("call-9", "Read image file [image/png]", false, [IMG]);
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [{ role: "user", content: "also check the build", timestamp: Date.now() }],
	});
	const errors = await collect(makeStreamSimple(driver, rt, "acp")(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions));
	assert.equal(errors.length, 0);
	assert.ok(seen.opts);
	assert.match(seen.opts.prompt, /you never received this result/);
	assert.deepEqual(seen.opts.images, [IMG]);
});
