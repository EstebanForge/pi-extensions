// Provider wiring for sync handoff mode (opt-in via AGY_HANDOFF=sync):
//
//   1. Sync dispatch shape: fresh conversations ride a gate-open prompt with
//      no context block and no digest fallback; warm conversations ride the
//      owed delta as the framed history block.
//   2. The sync settle persists the zeroed record (lastMessageCount 0, sync
//      snapshot, no digest watermark fields) and never emits digest events.
//   3. Digest mode stays byte-identical: no AGY_HANDOFF means the digest
//      flow, and stream-json never syncs even when the env asks for it.
//   4. The churn gate: a session latched digestFallback runs the digest flow
//      again, and three consecutive warm-session rebuilds latch it.
//
// Harness mirrors tests/provider-fallback.test.ts (fake driver + real store).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import {
	normalizeContext,
	type Api,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { ToolRoundTrips, createStreamSimple } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { StreamDriver, DriverTurnRequest } from "../src/driver.js";
import type { DriverActivity, TurnHandle, TurnOutcome } from "../src/driver-types.js";

const SYS = "You are pi. Follow AGENTS.md.";

const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
const fakeAgentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sync-home-"));
process.env.PI_CODING_AGENT_DIR = path.join(fakeAgentRoot, ".pi", "agent");
afterAll(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	fs.rmSync(fakeAgentRoot, { recursive: true, force: true });
});

const model: Model<Api> = {
	id: "gemini-flash",
	name: "Gemini 3.8 Flash",
	api: "agy-bridge" as Api,
	provider: "antigravity",
	baseUrl: "agy-bridge://antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function user(content: string, ts = 1000): Message {
	return { role: "user", content, timestamp: ts };
}

function foreignUser(content: string, ts: number): Message {
	return { role: "user", content, timestamp: ts };
}

function ownTurn(text: string, ts = 2000): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "agy-bridge" as never,
		provider: "antigravity",
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: ts,
	};
}

interface TurnScript {
	conversationId: string;
	response?: string;
	activities?: DriverActivity[];
	/** When set, the turn resolves as a failed outcome (ERROR, terminal). */
	failure?: string;
}

function makeFakeDriver(scripts: TurnScript[], requests: DriverTurnRequest[]): StreamDriver {
	let idx = 0;
	const driver = {
		get activeHandle() {
			return null;
		},
		kickIdle: () => {},
		reentry: () => null,
		snapshot: () => ({ state: "ready", conversationId: undefined, stats: {} }),
		run: async (opts: DriverTurnRequest) => {
			requests.push(opts);
			const script = scripts[Math.min(idx, scripts.length - 1)]!;
			idx += 1;
			const outcome: TurnOutcome = script.failure
				? {
						status: "ERROR",
						response: "",
						finished: true,
						aborted: false,
						conversationId: script.conversationId,
						modelOutputSeen: false,
						sawResult: true,
						promptAttempted: true,
						promptTerminal: true,
						error: script.failure,
					}
				: {
						status: "OK",
						response: script.response ?? "ok",
						finished: true,
						aborted: false,
						conversationId: script.conversationId,
						modelOutputSeen: true,
						sawResult: true,
						promptAttempted: true,
						promptTerminal: true,
					};
			const activities = [...(script.activities ?? [])];
			return {
				id: `fake-turn-${idx}`,
				outcome: Promise.resolve(outcome),
				next: async () => activities.shift() ?? null,
				pushExternal: () => {},
			} satisfies TurnHandle as unknown as TurnHandle;
		},
	};
	return driver as unknown as StreamDriver;
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

interface Harness {
	requests: DriverTurnRequest[];
	logs: Array<{ event: string; data?: unknown; level?: string }>;
	store: SessionStore;
	dir: string;
	engine: "acp" | "stream-json";
}

function harness(scripts: TurnScript[], engine: "acp" | "stream-json" = "acp"): Harness {
	const requests: DriverTurnRequest[] = [];
	const logs: Harness["logs"] = [];
	const driver = makeFakeDriver(scripts, requests);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sync-"));
	const store = new SessionStore(path.join(dir, "sessions.json"));
	const streamSimple = createStreamSimple({
		entries: [{ id: model.id, full: "gemini-3.8-flash" }],
		store,
		driver,
		...(engine === "acp" ? { acpDriver: driver, engine } : { engine }),
		roundTrips: new ToolRoundTrips(driver),
		log: (event, data, level) => logs.push({ event, data, level }),
	});
	const h: Harness = { requests, logs, store, dir, engine };
	(h as Harness & { stream: unknown }).stream = streamSimple;
	return h;
}

async function runTurn(h: Harness, messages: Message[], systemPrompt?: string): Promise<void> {
	const streamFn = (h as Harness & { stream: ReturnType<typeof createStreamSimple> }).stream;
	const ctx: TranscriptContext = normalizeContext({ systemPrompt, messages });
	const stream = streamFn(model, ctx, { cwd: h.dir, sessionId: "s-1" } as unknown as SimpleStreamOptions);
	for await (const ev of stream) void ev;
}

async function readRecord(h: Harness): Promise<Record<string, unknown>> {
	await h.store.flush();
	const raw = fs.readFileSync(path.join(h.dir, "sessions.json"), "utf8");
	const all = JSON.parse(raw) as Record<string, Record<string, unknown>>;
	const key = Object.keys(all)[0]!;
	return all[key] as Record<string, unknown>;
}

function cleanup(h: Harness): void {
	fs.rmSync(h.dir, { recursive: true, force: true });
}

const promptText = (req: DriverTurnRequest | undefined): string =>
	(req?.prompt ?? "");

test("sync mode: fresh conversation dispatches gate-open prompt without a context block", async () => {
	await withEnv({ AGY_HANDOFF: "sync", AGY_SYSTEM_PROMPT: "on" }, async () => {
		const h = harness([{ conversationId: "conv-1" }]);
		try {
			await runTurn(h, [user("first task", 1)], SYS);
			const req = h.requests[0];
			assert.ok(req, "the turn dispatched");
			assert.equal(req.conversationId, null, "a fresh sync conversation binds nothing");
			assert.ok(promptText(req).includes("first task"), "the user run is the prompt");
			assert.equal(req.contextBlock, undefined, "no history exists on the first turn");
			assert.equal(req.fallback, undefined, "sync builds no digest fallback");
			assert.ok(h.logs.some((l) => l.event === "sync-plan"), "the sync plan is logged");
			assert.ok(!h.logs.some((l) => l.event === "digest"), "digest telemetry stays silent");
			const record = await readRecord(h);
			assert.equal(record.conversationId, "conv-1");
			assert.equal(record.lastMessageCount, 0, "the zeroed persist contract");
			assert.ok(record.sync && typeof record.sync === "object", "the sync snapshot persists");
			assert.equal(record.digestBoundary, undefined, "no digest watermark on sync records");
		} finally {
			cleanup(h);
		}
	});
});

test("sync mode: warm conversation re-binds and ships the foreign delta as history", async () => {
	await withEnv({ AGY_HANDOFF: "sync", AGY_SYSTEM_PROMPT: "on" }, async () => {
		const h = harness([
			{ conversationId: "conv-1", response: "gamma-turn", activities: [{ type: "text", delta: "gamma-turn" } as DriverActivity] },
			{ conversationId: "conv-1" },
		]);
		try {
			// turn 1: [a] settles; turn 2 grows a foreign-provider exchange
			await runTurn(h, [user("alpha-root", 1)], SYS);
			await runTurn(
				h,
				[user("alpha-root", 1), ownTurn("gamma-turn", 2), foreignUser("from other agent", 3), ownTurn("foreign reply", 4), user("b", 5)],
				SYS,
			);
			assert.equal(h.requests.length, 2);
			const warm = h.requests[1]!;
			assert.equal(warm.conversationId, "conv-1", "the warm session re-binds");
			assert.ok(!promptText(warm).includes(SYS), "gate stays closed on a warm conversation");
			const block = warm.contextBlock as { uri: string; text: string } | undefined;
			assert.ok(block, "the owed delta ships as the history block");
			assert.equal(block.uri, "urn:pi-bridge:history:v1");
			assert.ok(block.text.includes("from other agent"), "the foreign exchange is the delta");
			assert.ok(!block.text.includes("alpha-root"), "checkpoint-covered history stays out");
			assert.ok(!block.text.includes("gamma-turn"), "the echoed assistant absorbed into the checkpoint");
		} finally {
			cleanup(h);
		}
	});
});

test("digest mode stays the default and writes the digest watermark", async () => {
	await withEnv({}, async () => {
		const h = harness([{ conversationId: "conv-1" }]);
		try {
			await runTurn(h, [user("first task", 1)], SYS);
			assert.ok(h.logs.some((l) => l.event === "digest"), "the digest telemetry runs");
			assert.ok(!h.logs.some((l) => l.event === "sync-plan"), "no sync plan is logged");
			const record = await readRecord(h);
			// the system prompt rides context.messages as a message, so the
			// digest watermark counts it: [system, user] = 2
			assert.equal(record.lastMessageCount, 2, "the digest watermark advances");
			assert.equal(record.sync, undefined, "no sync snapshot on digest records");
		} finally {
			cleanup(h);
		}
	});
});

test("stream-json never syncs even when AGY_HANDOFF=sync", async () => {
	await withEnv({ AGY_HANDOFF: "sync" }, async () => {
		const h = harness([{ conversationId: "conv-1" }], "stream-json");
		try {
			await runTurn(h, [user("first task", 1)], SYS);
			assert.ok(h.logs.some((l) => l.event === "digest"), "the digest flow ran");
			assert.ok(!h.logs.some((l) => l.event === "sync-plan"), "sync stays off on stream-json");
		} finally {
			cleanup(h);
		}
	});
});

test("a digestFallback latch forces the digest flow back on", async () => {
	await withEnv({ AGY_HANDOFF: "sync", AGY_SYSTEM_PROMPT: "on" }, async () => {
		const h = harness([{ conversationId: "conv-d" }]);
		try {
			// Seed a warm record whose sync state carries the churn latch.
			await h.store.set("sid:s-1@acp", {
				conversationId: "conv-old",
				lastStepIdx: -1,
				lastMessageCount: 0,
				sync: { version: 1, epoch: 4, digestFallback: true },
			});
			await h.store.flush();
			await runTurn(h, [user("first task", 1)], SYS);
			assert.ok(h.logs.some((l) => l.event === "digest"), "the digest flow ran");
			assert.ok(!h.logs.some((l) => l.event === "sync-plan"), "the latch excludes sync");
			const req = h.requests[0]!;
			assert.equal(req.conversationId, "conv-old", "digest reuses the stored binding");
		} finally {
			cleanup(h);
		}
	});
});

test("three consecutive warm-session rebuilds latch digestFallback", async () => {
	await withEnv({ AGY_HANDOFF: "sync", AGY_SYSTEM_PROMPT: "on" }, async () => {
		const h = harness([
			{ conversationId: "conv-1" },
			{ conversationId: "conv-2" },
			{ conversationId: "conv-3" },
			{ conversationId: "conv-3" },
		]);
		try {
			// Seed a warm record whose checkpoint matches NOTHING (simulating
			// per-turn context-hook rewrites), then rewrite the transcript's
			// first message text before every turn so every plan rebuilds.
			await h.store.set("sid:s-1@acp", {
				conversationId: "conv-0",
				lastStepIdx: -1,
				lastMessageCount: 0,
				sync: {
					version: 1,
					epoch: 0,
					checkpoint: { entryCount: 1, hash: "0".repeat(64) },
				},
			});
			await h.store.flush();
			for (let i = 1; i <= 3; i++) {
				await runTurn(h, [user(`rewritten ${i}`, 1)], SYS);
			}
			const latched = await readRecord(h);
			const syncState = latched.sync as { digestFallback?: boolean } | undefined;
			assert.equal(syncState?.digestFallback, true, "the churn gate latched after three rebuilds");
			assert.ok(!h.logs.some((l) => l.event === "digest"), "the first three turns stayed on sync");
			// The next turn falls back to digest, reusing the stored binding
			// (a mismatched id would hit the binding-diff delete instead).
			await runTurn(h, [user("rewritten 4", 1), ownTurn("x", 2), user("after", 3)], SYS);
			assert.ok(h.logs.some((l) => l.event === "digest"), "the fourth turn ran the digest flow");
			// The latch must survive the digest settle, or the gate re-opens on
			// the following turn and the session alternates rebuild/digest.
			const afterDigest = await readRecord(h);
			const latch = (afterDigest.sync as { digestFallback?: boolean } | undefined)?.digestFallback;
			assert.equal(latch, true, "the latch survives the digest turn");
		} finally {
			cleanup(h);
		}
	});
});

test("failure-induced rebuilds never latch the churn gate", async () => {
	await withEnv({ AGY_HANDOFF: "sync", AGY_SYSTEM_PROMPT: "on" }, async () => {
		const h = harness([
			{ conversationId: "conv-1" },
			{ conversationId: "conv-e", failure: "boom" },
			{ conversationId: "conv-e", failure: "boom" },
			{ conversationId: "conv-e", failure: "boom" },
			{ conversationId: "conv-5" },
		]);
		try {
			// Turn 1 confirms a checkpoint; turn 2 continues warm but fails
			// (unconfirmed-turn invalidation); turns 3-4 rebuild over the
			// invalidReason. Those are failure-induced rebuilds: they must
			// never count toward the churn latch, or three transient errors
			// would pin the session to digest for its lifetime.
			for (let i = 1; i <= 5; i++) {
				await runTurn(h, [user("stable task", 1)], SYS);
			}
			assert.ok(!h.logs.some((l) => l.event === "sync-churn-fallback"), "no churn latch from failures");
			const plans = h.logs.filter((l) => l.event === "sync-plan");
			assert.equal(plans.length, 5, "every turn stayed on sync");
			const lastReq = h.requests[4]!;
			assert.equal(lastReq.conversationId, null, "the fifth turn still rebuilt fresh over the invalid state");
		} finally {
			cleanup(h);
		}
	});
});
