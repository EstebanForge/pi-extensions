// Issue #25 follow-ups, provider layer:
//
//   1. Fresh-mode fallback: a bound ACP turn must carry a fallback prompt +
//      context digest built as-if-fresh (system prompt gate open, own turns
//      included), so an ACP session/load failure that silently creates a
//      fresh agy conversation still receives the system prompt and pi-side
//      context instead of answering blind.
//   2. Watermark delivery invariant: when a digest build produced content
//      (or the budget was spent before any build) but nothing shipped
//      (stream-json byte cap / exhausted budget), the settle write must
//      HOLD the watermark - re-offering duplicates nothing because nothing
//      reached agy. Partial renders (budget cut the oldest turns) still
//      advance but log the hole: the hole can never re-fit under the
//      newest-first budget, and re-offering it every turn would re-embed
//      cap-sized duplicate blocks into agy's DB.
//
// Harness note: adjacent user messages form ONE trailing run left-bounded
// by the watermark, so every non-empty digest window below needs an
// assistant message separating the backlog from the final user prompt.

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

// Isolate loadConfig() from any live agent dir on the runner's machine.
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
const fakeAgentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fallback-home-"));
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

/** Distinct timestamps: the digest boundary fingerprint is role:timestamp,
 *  and equal stamps across messages read as a mutated transcript. */
function user(content: string, ts = 1000): Message {
	return { role: "user", content, timestamp: ts };
}

function ownTurn(text: string, ts = 2000): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "agy-bridge" as never,
		provider: "antigravity" as never,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: ts,
	};
}

interface TurnScript {
	outcome: TurnOutcome;
	activities?: DriverActivity[];
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
			const activities = [...(script.activities ?? [])];
			return {
				id: `fake-turn-${idx}`,
				outcome: Promise.resolve(script.outcome),
				next: async () => activities.shift() ?? null,
				pushExternal: () => {},
			} satisfies TurnHandle as unknown as TurnHandle;
		},
	};
	return driver as unknown as StreamDriver;
}

function okOutcome(conversationId: string, response = "ok"): TurnOutcome {
	return {
		status: "OK",
		response,
		finished: true,
		aborted: false,
		conversationId,
		modelOutputSeen: true,
		sawResult: true,
	};
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

function harness(outcomes: string[], engine: "acp" | "stream-json" = "acp"): Harness {
	const requests: DriverTurnRequest[] = [];
	const logs: Harness["logs"] = [];
	const driver = makeFakeDriver(
		outcomes.map((c) => ({ outcome: okOutcome(c) })),
		requests,
	);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fallback-"));
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
	// Draining is the caller's job; keep the stream fn reachable via the box.
	(h as Harness & { stream: unknown }).stream = streamSimple;
	return h;
}

async function runTurn(h: Harness, messages: Message[], systemPrompt?: string): Promise<void> {
	const streamFn = (h as Harness & { stream: ReturnType<typeof createStreamSimple> }).stream;
	const ctx: TranscriptContext = normalizeContext({ systemPrompt, messages });
	const stream = streamFn(model, ctx, { cwd: h.dir, sessionId: "s-1" } as unknown as SimpleStreamOptions);
	for await (const ev of stream) void ev;
}

/** The settle write is queued through the store's write chain; flush before
 *  reading the store file or the read races the rename. */
async function readRecord(h: Harness): Promise<Record<string, unknown>> {
	await h.store.flush();
	const raw = fs.readFileSync(path.join(h.dir, "sessions.json"), "utf8");
	const all = JSON.parse(raw) as Record<string, Record<string, unknown>>;
	const key = Object.keys(all)[0]!;
	return all[key] as Record<string, unknown>;
}

async function waitFor(fn: () => Promise<void>): Promise<void> {
	let last: unknown = new Error("never ran");
	for (let i = 0; i < 100; i++) {
		try {
			await fn();
			return;
		} catch (err) {
			last = err;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
	throw last;
}

test("unbound turn ships no fallback", async () => {
	await withEnv({ AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "off" }, async () => {
		const h = harness(["conv-a"]);
		try {
			await runTurn(h, [user("first task")]);
			assert.equal(h.requests[0]?.fallback, undefined, "nothing to fall back from on a fresh conversation");
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});

test("bound ACP turn carries a fresh-mode fallback (issue #25)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fb-agents-"));
	await withEnv({ AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "on", AGY_AGENTS_ROOT: root }, async () => {
		const h = harness(["conv-a", "conv-a"]);
		try {
			await runTurn(h, [user("first task", 1)], SYS);
			await runTurn(h, [user("first task", 1), ownTurn("own turn words", 2), user("second", 3)], SYS);
			const req = h.requests[1]!;
			assert.equal(req.conversationId, "conv-a");
			assert.ok(!req.prompt.includes(SYS), "the bound turn keeps the G10 gate closed");
			assert.equal(req.contextBlock, undefined, "bound delta is empty here, no digest block");
			const fb = req.fallback;
			assert.ok(fb, "a bound turn must prebuild the fresh-session variant");
			assert.ok(fb.prompt.includes(SYS), "the fallback opens the system-prompt gate");
			assert.ok(fb.prompt.includes("second"), "the fallback carries the user prompt");
			assert.ok(
				fb.contextBlock?.text.includes("own turn words"),
				"the fallback digest is bound:false: own turns ship",
			);
			assert.ok(fb.contextBlock?.text.includes("first task"));
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

test("stream-json byte-cap drop holds the watermark (multibyte digest)", async () => {
	await withEnv({ AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "off" }, async () => {
		const h = harness(["conv-a", "conv-a"], "stream-json");
		try {
			await runTurn(h, [user("seed", 1)]);
			// Emoji are 4 bytes/char: the char budget over-reserves, the byte
			// check then fails the ship (issue #2 fail-closed). The assistant
			// turn keeps the emoji inside the digest window.
			await runTurn(h, [
				user("seed", 1),
				user("\u{1F600}".repeat(3000), 2),
				ownTurn("bridge turn", 3),
				user("x".repeat(14_000), 4),
			]);
			await waitFor(async () => {
				const rec = await readRecord(h);
				assert.equal(rec.lastMessageCount, 1, `built-but-dropped: ${JSON.stringify(rec)}`);
			});
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});

test("partial digest render advances but logs the skipped span", async () => {
	await withEnv({ AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "off" }, async () => {
		const h = harness(["conv-a"]);
		try {
			// Window [0..2): one 25000-char part plus a small assistant turn
			// against the 24000 budget. Newest-first keeps the assistant turn,
			// the 25000-char message is only partially covered (tail slice).
			await runTurn(h, [user("h".repeat(25_000), 1), ownTurn("kept tail", 2), user("s".repeat(20), 3)]);
			const req = h.requests[0]!;
			assert.ok(req.contextBlock?.text, "the capped digest still ships");
			await waitFor(async () => {
				const rec = await readRecord(h);
				assert.equal(rec.lastMessageCount, 3, `partial: ${JSON.stringify(rec)}`);
			});
			const ev = h.logs.find((l) => l.event === "digest");
			assert.ok(ev, "digest telemetry event expected");
			const data = ev.data as { shipped?: boolean; deliveredFrom?: number; windowStart?: number };
			assert.equal(data.shipped, true);
			assert.equal(data.deliveredFrom, 1);
			assert.equal(data.windowStart, 0);
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});

test("empty delta still advances the watermark (nothing owed)", async () => {
	await withEnv({ AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "off" }, async () => {
		const h = harness(["conv-a", "conv-a"]);
		try {
			await runTurn(h, [user("first", 1)]);
			await runTurn(h, [user("first", 1), user("second", 2)]);
			await waitFor(async () => {
				const rec = await readRecord(h);
				assert.equal(rec.lastMessageCount, 2, `empty-delta: ${JSON.stringify(rec)}`);
			});
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});
