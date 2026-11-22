// Trailing user-run extraction (issue #24): pi routinely stacks consecutive
// role:"user" messages at the transcript tail (user prompt + before_agent_start
// note, queued nextTurn messages, bash runs). extractUserPrompt/extractImages
// used to read only the LAST message, so earlier prompts were dropped
// (digest off), demoted into the digest (digest on), and earlier images were
// lost. The run is watermark-bounded: messages at or before the watermark are
// failed-turn backlog and keep riding the digest as continuity context, never
// the prompt (the re-execution guard pinned by provider-watermark.test.ts).
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import {
	normalizeContext,
	type Api,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ToolRoundTrips, createStreamSimple } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { StreamDriver, DriverTurnRequest } from "../src/driver.js";

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

// Stable per-text timestamps: the digest boundary fingerprint is role:ts, so
// a rebuilt message must keep its stamp across turns (see provider-watermark).
function hash(text: string): number {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
	return h;
}
function user(text: string): Message {
	return { role: "user", content: text, timestamp: hash(text) };
}
function asst(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages" as never,
		provider: "antigravity" as never,
		model: "m",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: hash(text),
	};
}
function compaction(summary: string): Message {
	return user(
		"The conversation history before this point was compacted into the following summary:\n\n<summary>\n" +
			summary +
			"\n</summary>",
	);
}
function userWithImage(text: string): Message {
	return {
		role: "user",
		content: [
			{ type: "text", text },
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		],
		timestamp: hash(text),
	};
}

function contextWith(messages: Message[]): TranscriptContext {
	return normalizeContext({ systemPrompt: undefined, messages });
}

interface Harness {
	seen: { opts?: DriverTurnRequest };
	streamSimple: ReturnType<typeof createStreamSimple>;
	storePath: string;
	dir: string;
}

type FakeOutcome =
	| string
	| { conversationId?: string; status?: "OK" | "ERROR" | "UNKNOWN"; aborted?: boolean; error?: string };

function harness(outcomes: FakeOutcome[]): Harness {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver: StreamDriver = {
		run: async (opts: DriverTurnRequest) => {
			seen.opts = opts;
			const raw = outcomes.shift();
			const shaped = typeof raw === "string" ? { conversationId: raw } : (raw ?? {});
			return {
				id: "fake-turn",
				outcome: Promise.resolve({
					status: "OK",
					response: "ok",
					finished: true,
					aborted: false,
					...shaped,
				}),
				next: async () => null,
				pushExternal: () => {},
			};
		},
	} as unknown as StreamDriver;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-user-run-"));
	const store = new SessionStore(path.join(dir, "sessions.json"));
	const streamSimple = createStreamSimple({
		entries: [{ id: "gemini-flash", full: "gemini-3.6-flash" }],
		store,
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	return { seen, streamSimple, storePath: path.join(dir, "sessions.json"), dir };
}

async function runTurn(h: Harness, messages: Message[]): Promise<void> {
	const stream = h.streamSimple(model, contextWith(messages), {
		cwd: h.dir,
	} as unknown as SimpleStreamOptions);
	for await (const ev of stream) void ev;
}

function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const prev: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(values)) {
		prev[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	return fn().finally(() => {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

test("prompt + extension note both reach agy with digest off (issue #24 case A)", async () => {
	const h = harness(["conv-a"]);
	try {
		await withEnv({ AGY_DIGEST: "0" }, async () => {
			await runTurn(h, [user("Reply with the word BANANA"), user("Extension note: reply concisely.")]);
		});
		const prompt = h.seen.opts?.prompt ?? "";
		assert.ok(prompt.includes("BANANA"), "the user prompt must reach agy, not only the note");
		assert.ok(prompt.includes("Extension note"), "the same-turn extension note must reach agy");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("digest on: prompt + note join the prompt, no [earlier user message] demotion", async () => {
	const h = harness(["conv-a"]);
	try {
		await withEnv({ AGY_DIGEST: undefined }, async () => {
			await runTurn(h, [user("Reply with the word BANANA"), user("Extension note: reply concisely.")]);
		});
		const prompt = h.seen.opts?.prompt ?? "";
		assert.ok(prompt.includes("BANANA"), "the prompt must not be demoted into the digest");
		assert.ok(prompt.includes("Extension note"));
		assert.ok(
			!prompt.includes("[earlier user message]"),
			"same-turn messages must not reappear as digest continuity context",
		);
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("an image attached to an earlier same-turn message reaches the driver", async () => {
	const h = harness(["conv-a"]);
	try {
		await withEnv({ AGY_DIGEST: undefined }, async () => {
			await runTurn(h, [
				userWithImage("What is in this image?"),
				user("Extension note: reply concisely."),
			]);
		});
		assert.equal(h.seen.opts?.images?.length, 1, "the image must not be dropped with the older message");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("a whitespace-only trailing message does not kill the turn", async () => {
	const h = harness(["conv-a"]);
	try {
		await withEnv({ AGY_DIGEST: "0" }, async () => {
			await runTurn(h, [user("real prompt"), user("   ")]);
		});
		assert.ok(h.seen.opts, "the turn must run, not fail with the no-user-message error");
		assert.ok(h.seen.opts?.prompt?.includes("real prompt"));
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("messages after the watermark join; a completed prior turn does not", async () => {
	const h = harness(["conv-a", "conv-a"]);
	try {
		await withEnv({ AGY_DIGEST: undefined }, async () => {
			await runTurn(h, [user("task one")]);
			await runTurn(h, [user("task one"), asst("done"), user("new prompt"), user("note")]);
		});
		const prompt = h.seen.opts?.prompt ?? "";
		assert.ok(prompt.includes("new prompt"), "the fresh prompt must reach agy");
		assert.ok(prompt.includes("note"), "the note appended after the fresh prompt joins the run");
		assert.ok(
			!prompt.includes("[earlier user message]"),
			"post-watermark same-turn messages join the prompt instead of the digest",
		);
		assert.ok(prompt.trimEnd().endsWith("note"), "the run is the prompt tail, not digest content");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("failed-turn backlog stays out of the prompt (watermark bound)", async () => {
	const h = harness(["conv-a", { conversationId: "conv-a", status: "ERROR", error: "boom" }, "conv-a"]);
	try {
		await withEnv({ AGY_DIGEST: undefined }, async () => {
			await runTurn(h, [user("first task")]);
			// The failed turn must not advance the watermark; wait for the
			// queued persist so turn 2 reads the settled record.
			await vi.waitFor(() => {
				const disk = JSON.parse(fs.readFileSync(h.storePath, "utf8")) as Record<string, unknown>;
				assert.ok(Object.keys(disk).length > 0, "turn 1 record persisted");
			});
			await runTurn(h, [user("first task"), user("second")]);
		});
		const prompt = h.seen.opts?.prompt ?? "";
		assert.ok(
			!prompt.includes("first task"),
			"backlog at or below the watermark must not re-execute as prompt (issue #1 class guard)",
		);
		assert.ok(prompt.trimEnd().endsWith("second"), "the newest message is the prompt");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("compaction summaries never join the prompt run", async () => {
	const h = harness(["conv-a"]);
	try {
		await withEnv({ AGY_DIGEST: "0" }, async () => {
			await runTurn(h, [compaction("we chose sqlite"), user("current prompt")]);
		});
		const prompt = h.seen.opts?.prompt ?? "";
		assert.ok(prompt.includes("current prompt"));
		assert.ok(!prompt.includes("sqlite"), "the compaction summary must not sweep into the prompt");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("branch summaries and bash-run texts never join the prompt run", async () => {
	const h = harness(["conv-a"]);
	try {
		await withEnv({ AGY_DIGEST: "0" }, async () => {
			await runTurn(h, [
				user("The following is a summary of a branch that this conversation came back from:\n\n<summary>\ndetail\n</summary>"),
				user("Ran `ls`\nsome output"),
				user("current prompt"),
			]);
		});
		const prompt = h.seen.opts?.prompt ?? "";
		assert.ok(prompt.includes("current prompt"));
		assert.ok(!prompt.includes("detail"), "branch summary stays out of the prompt");
		assert.ok(!prompt.includes("some output"), "bash-run backlog stays out of the prompt");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("a non-user message stops the run scan (system notes stay out)", async () => {
	const h = harness(["conv-a"]);
	try {
		await withEnv({ AGY_DIGEST: "0" }, async () => {
			await runTurn(h, [user("older prompt"), asst("mid answer"), user("current prompt")]);
		});
		const prompt = h.seen.opts?.prompt ?? "";
		assert.ok(prompt.includes("current prompt"));
		assert.ok(!prompt.includes("older prompt"), "the run stops at the last non-user message");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("single-message turns keep working unchanged", async () => {
	const h = harness(["conv-a"]);
	try {
		await withEnv({ AGY_DIGEST: "0" }, async () => {
			await runTurn(h, [user("solo prompt")]);
		});
		assert.equal(h.seen.opts?.prompt, "solo prompt");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});
