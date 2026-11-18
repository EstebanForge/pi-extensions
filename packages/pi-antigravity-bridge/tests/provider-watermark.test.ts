// Regression tests for issue #1 (pi-antigravity-bridge): a RECREATED agy
// conversation must not inherit the old conversation's digest watermark.
//
// Reproduction at the provider layer, engine-agnostic: a fake driver returns a
// conversationId DIFFERENT from the stored one. That is exactly what the ACP
// driver does when session/load fails and it falls back to a fresh session
// ("session-load-failed-creating-fresh"), and what stream-json does when the
// CLI drops a stale --conversation id. The provider must detect the swap at
// the end-of-turn write-back and DROP the stale record: the recreated
// conversation has seen nothing, so the next turn must re-deliver the backlog
// (digest from watermark 0) and re-arm the system-prompt gate.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import {
	normalizeContext,
	type Api,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	SYSTEM_PROMPT_PREAMBLE,
	ToolRoundTrips,
	createStreamSimple,
} from "../src/provider.js";
import { resetSyspromptAgentForTests } from "../src/sysprompt-agent.js";
import { SessionStore } from "../src/sessions.js";
import type { StreamDriver, DriverTurnRequest } from "../src/driver.js";

const SYS = "You are pi. Follow AGENTS.md.";

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

// pi persists message timestamps, so a message keeps its ts across turns;
// derive a stable one from the text instead of Date.now() (a fresh stamp per
// rebuild reads as a mutated transcript to the digest boundary fingerprint).
function user(text: string): { role: "user"; content: string; timestamp: number } {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
	return { role: "user", content: text, timestamp: h };
}

function contextWith(messages: string[], systemPrompt?: string): TranscriptContext {
	return normalizeContext({
		systemPrompt,
		messages: messages.map(user),
	});
}

interface Harness {
	seen: { opts?: DriverTurnRequest };
	streamSimple: ReturnType<typeof createStreamSimple>;
	store: SessionStore;
	storePath: string;
	dir: string;
}

/** Fake driver: outcomes queue hands one entry per turn. A string is a
 *  successful outcome bound to that conversation id; an object overrides
 *  status/aborted/error to shape failed or aborted turns. */
type FakeOutcome = string | { conversationId?: string; status?: "OK" | "ERROR" | "UNKNOWN"; aborted?: boolean; error?: string };

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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-watermark-"));
	const store = new SessionStore(path.join(dir, "sessions.json"));
	const streamSimple = createStreamSimple({
		entries: [{ id: "gemini-flash", full: "gemini-3.6-flash" }],
		store,
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	return { seen, streamSimple, store, storePath: path.join(dir, "sessions.json"), dir };
}

async function runTurn(h: Harness, messages: string[], systemPrompt?: string): Promise<void> {
	const stream = h.streamSimple(
		model,
		contextWith(messages, systemPrompt),
		{ cwd: h.dir } as unknown as SimpleStreamOptions,
	);
	for await (const ev of stream) void ev;
}

function withEnv(values: Record<string, string>, fn: () => Promise<void>): Promise<void> {
	const prev: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(values)) {
		prev[k] = process.env[k];
		process.env[k] = v;
	}
	return fn().finally(() => {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

/** Wait for the queued persist chain to land, then read the file. */
async function readDisk(storePath: string): Promise<Record<string, unknown>> {
	return vi.waitFor(() => {
		return JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>;
	});
}

function readStore(storePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>;
}

test("same conversation across turns: watermark advances normally (happy path)", async () => {
	await withEnv({ AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "off" }, async () => {
		const h = harness(["conv-a", "conv-a"]);
		try {
			await runTurn(h, ["first task"]);
			await runTurn(h, ["first task", "second"]);
			// Turn 2 resumed conv-a, which already holds turn 1: bare prompt, and
			// the watermark advances to the current pi message count.
			assert.equal(h.seen.opts?.conversationId, "conv-a");
			assert.equal(h.seen.opts?.prompt, "second");
			const disk = await readDisk(h.storePath);
			const rec = Object.values(disk)[0] as { conversationId: string; lastMessageCount: number };
			assert.equal(rec.conversationId, "conv-a");
			assert.equal(rec.lastMessageCount, 2);
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});

test("recreated conversation: stale record is dropped and the backlog is re-delivered", async () => {
	await withEnv({ AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "off" }, async () => {
		const h = harness(["conv-a", "conv-b", "conv-c"]);
		try {
			await runTurn(h, ["first task"]);
			const disk1 = await readDisk(h.storePath);
			const key = Object.keys(disk1)[0];
			assert.equal((disk1[key] as { conversationId: string }).conversationId, "conv-a");

			// Turn 2: the driver recreates the conversation (conv-b). The record
			// must be dropped, not advanced: conv-b has seen nothing.
			await runTurn(h, ["first task", "second"]);
			assert.equal(h.seen.opts?.conversationId, "conv-a", "recreation turn still passes the stored id");
			assert.equal(h.store.get(key), null, "record must be dropped on conversation swap");
			// Deletion lands through the queued persist chain; wait it out.
			await vi.waitFor(() => {
				const disk2 = readStore(h.storePath);
				assert.ok(!(key in disk2), "dropped record must not persist");
			});

			// Turn 3: a fresh conversation with watermark 0 must re-deliver the
			// pi-side backlog it never saw.
			await runTurn(h, ["first task", "second", "continue"]);
			assert.equal(h.seen.opts?.conversationId, null, "next turn starts a fresh conversation");
			const prompt = h.seen.opts?.prompt ?? "";
			assert.ok(prompt.includes("[earlier user message]"), "digest must be present");
			assert.ok(prompt.includes("first task"), "backlog must include the pre-recreation turn");
			assert.ok(prompt.endsWith("continue"));
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});

test("recreated conversation: system-prompt gate re-arms on the next turn", async () => {
	// Staged-agent delivery: re-arm means the fresh conversation's carrier
	// body is REFRESHED with the current system prompt, and the prompt line
	// never carries the block.
	const SYS2 = "You are pi v2. Follow the NEW rules.";
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wm-agents-"));
	await withEnv({ AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "on", AGY_AGENTS_ROOT: root }, async () => {
		resetSyspromptAgentForTests();
		const h = harness(["conv-a", "conv-b", "conv-c"]);
		try {
			await runTurn(h, ["first task"], SYS);
			await runTurn(h, ["first task", "second"], SYS);
			// Turn 2 (the recreation turn itself) still rides the OLD gate: the
			// decision happens before the driver can swap the conversation. This
			// is the documented residual; recovery starts on the next turn.
			assert.ok(!(h.seen.opts?.prompt ?? "").includes(SYS2));
			await runTurn(h, ["first task", "second", "continue"], SYS2);
			// Dropped record => existing is null => the gate is open again: the
			// carrier body is refreshed with the CURRENT system prompt and the
			// prompt line stays bare.
			const agent = h.seen.opts?.agent ?? "";
			assert.ok(agent.startsWith("pi-bridge-sys-"));
			const md = fs.readFileSync(path.join(root, agent, "agent.md"), "utf8");
			assert.ok(md.includes(SYS2), "carrier body refreshed on re-arm");
			assert.ok(!(h.seen.opts?.prompt ?? "").includes(SYS2));
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

test("failed turn on the same conversation: watermark is not advanced (backlog re-delivered)", async () => {
	// System prompt ON so the closing gate assertion is real: a surviving
	// record must keep the gate CLOSED (no second system prompt to a still-
	// bound conversation). Under AGY_SYSTEM_PROMPT=off the gate is
	// short-circuited at the config level and the assertion would be vacuous.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wm-agents-"));
	await withEnv({ AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "on", AGY_AGENTS_ROOT: root }, async () => {
		resetSyspromptAgentForTests();
		const h = harness([
			"conv-a",
			{ conversationId: "conv-a", status: "ERROR", error: "boom" },
			"conv-a",
		]);
		try {
			await runTurn(h, ["first task"], SYS);
			const disk1 = await readDisk(h.storePath);
			const key = Object.keys(disk1)[0];
			const base = (disk1[key] as { conversationId: string; lastMessageCount: number }).lastMessageCount;
			await runTurn(h, ["first task", "second"], SYS);
			// agy's state after a failure is ambiguous (the prompt may never have
			// landed), so the pre-turn watermark must survive unchanged. Advancing
			// it would starve the digest of the missed turn (issue #1 class).
			const disk2 = await readDisk(h.storePath);
			const rec = disk2[key] as { conversationId: string; lastMessageCount: number };
			assert.equal(rec.conversationId, "conv-a");
			assert.equal(rec.lastMessageCount, base, "failed turn must not advance the watermark");

			await runTurn(h, ["first task", "second", "continue"], SYS);
			const prompt = h.seen.opts?.prompt ?? "";
			assert.ok(prompt.includes("[earlier user message]"), "digest present");
			assert.ok(prompt.includes("second"), "the missed turn is re-delivered");
			assert.ok(prompt.endsWith("continue"));
			// The record survived, so the gate stays closed: the conversation is
			// still bound and must not receive a second system prompt. Staged
			// delivery: the carrier keeps riding (profile stability) but the
			// prompt line never carries the block.
			assert.ok(!(prompt.includes(SYS)), "no inline system prompt");
			assert.ok((h.seen.opts?.agent ?? "").startsWith("pi-bridge-sys-"));
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

test("unknown-status turn on the same conversation: watermark is not advanced", async () => {
	await withEnv({ AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "off" }, async () => {
		const h = harness([
			"conv-a",
			{ conversationId: "conv-a", status: "UNKNOWN" },
			"conv-a",
		]);
		try {
			await runTurn(h, ["first task"]);
			await runTurn(h, ["first task", "second"]);
			const disk = await readDisk(h.storePath);
			const key = Object.keys(disk)[0];
			const rec = disk[key] as { conversationId: string; lastMessageCount: number };
			assert.equal(rec.conversationId, "conv-a");
			assert.equal(rec.lastMessageCount, 1, "unknown outcome must not advance the watermark");
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});

test("aborted turn on the same conversation: watermark is not advanced", async () => {
	await withEnv({ AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "off" }, async () => {
		const h = harness([
			"conv-a",
			{ conversationId: "conv-a", status: "OK", aborted: true },
			"conv-a",
		]);
		try {
			await runTurn(h, ["first task"]);
			await runTurn(h, ["first task", "second"]);
			const disk = await readDisk(h.storePath);
			const key = Object.keys(disk)[0];
			const rec = disk[key] as { conversationId: string; lastMessageCount: number };
			assert.equal(rec.conversationId, "conv-a");
			assert.equal(rec.lastMessageCount, 1, "aborted turn must not advance the watermark");
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});
