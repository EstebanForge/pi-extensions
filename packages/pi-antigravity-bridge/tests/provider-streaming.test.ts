// Provider effort-mapping tests. Drives createStreamSimple with an injected
// fake driver (no agy spawn, no network) and asserts how the provider
// translates pi's options.reasoning into the agy --effort tier: forwarded
// for effort-driven bases, clamped to the base's supported tiers, omitted
// for fixed-thinking models. toAgyEffort itself is pinned by a pure unit test.
//
// The legacy provider event-mapping tests (close-on-switch, tool labels,
// empty turn) died with the legacy-sqlite engine; the stream-json path is
// covered by tests/stream-roundtrip.test.ts.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, afterAll } from "vitest";
import {
	createAssistantMessageEventStream,
	normalizeContext,
	type Api,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ToolRoundTrips, WrapperReplay, consumeActivity, createStreamSimple, sessionKey } from "../src/provider.js";
import { toAgyEffort } from "../src/models.js";
import { TurnDiffContext } from "../src/diff-render.js";
import { SessionStore } from "../src/sessions.js";
import type { StreamDriver, DriverTurnRequest } from "../src/driver.js";

// The provider reads the bridge config through loadConfig(), whose default
// path follows pi's agent dir (PI_CODING_AGENT_DIR). A user's live bridge
// config (say, turnTimeoutMin) would leak into these asserts, so the whole
// file runs against a throwaway agent dir: no config file means pure
// defaults plus the env vars each test sets.
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
const fakeAgentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-provider-home-"));
process.env.PI_CODING_AGENT_DIR = path.join(fakeAgentRoot, ".pi", "agent");
afterAll(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	fs.rmSync(fakeAgentRoot, { recursive: true, force: true });
});

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

function contextWith(prompt: string): TranscriptContext {
	return normalizeContext({
		systemPrompt: undefined,
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	});
}

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-prov-")), "sessions.json");
}

/** A fake driver that records the run() opts so a test can assert how the
 *  provider translated pi's options into agy turn opts. The handle emits no
 *  activities and settles OK. A conversationId makes the OK settle bind the
 *  session record (production outcomes carry it), enabling multi-turn tests
 *  through one store. */
function capturingDriver(seen: { opts?: DriverTurnRequest }, conversationId?: string): StreamDriver {
	return {
		run: async (opts: DriverTurnRequest) => {
			seen.opts = opts;
			return {
				id: "fake-turn",
				outcome: Promise.resolve({
					status: "OK",
					response: "ok",
					finished: true,
					aborted: false,
					...(conversationId ? { conversationId } : {}),
				}),
				next: async () => null,
				pushExternal: () => {},
			};
		},
	} as unknown as StreamDriver;
}

/** Run one scripted turn through streamSimple; returns the captured turn
 *  request the provider handed to the driver. */
async function captureTurn(
	entry: { full: string; id: string; efforts?: ("low" | "medium" | "high")[] },
	reasoning: string | undefined,
): Promise<DriverTurnRequest | undefined> {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = capturingDriver(seen);
	const streamSimple = createStreamSimple({
		entries: [entry],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	const stream = streamSimple(
		{ ...model, id: entry.id },
		contextWith("ignored by fake"),
		{ cwd: process.cwd(), reasoning } as unknown as SimpleStreamOptions,
	);
	for await (const ev of stream) void ev;
	return seen.opts;
}

test("toAgyEffort maps pi levels onto the base's supported tiers (clamped)", () => {
	const flash = ["low", "medium", "high"] as const;
	const pro = ["low", "high"] as const;
	assert.equal(toAgyEffort("low", flash), "low");
	assert.equal(toAgyEffort("medium", flash), "medium");
	assert.equal(toAgyEffort("high", flash), "high");
	assert.equal(toAgyEffort("minimal", flash), "low");
	// Pro has no medium -> clamp up to nearest available (high).
	assert.equal(toAgyEffort("medium", pro), "high");
	assert.equal(toAgyEffort("low", pro), "low");
	assert.equal(toAgyEffort("high", pro), "high");
	// No level -> default to the cheapest available tier.
	assert.equal(toAgyEffort(undefined, flash), "low");
	assert.equal(toAgyEffort(undefined, pro), "low");
});

test("streamSimple forwards image blocks from the user message to the driver", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = capturingDriver(seen);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] }],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [
			{
				role: "user",
				timestamp: Date.now(),
				content: [
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					{ type: "text", text: "What is this?" },
				],
			},
		],
	});
	const stream = streamSimple(
		{ ...model, id: "gemini-flash" },
		context,
		{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
	);
	for await (const ev of stream) void ev;
	// Text rides as the prompt (with the staged-file note appended on the
	// stream-json engine, whose turn input is text-only); images still ride
	// separately (the stream driver ignores them, the ACP driver forwards
	// them as typed content blocks).
	assert.match(seen.opts?.prompt ?? "", /^What is this\?/);
	assert.match(seen.opts?.prompt ?? "", /pi-bridge-img-.*image-1\.png/s);
	assert.match(seen.opts?.prompt ?? "", /pi read tool/i);
	assert.deepEqual(seen.opts?.images, [{ data: "aGVsbG8=", mimeType: "image/png" }]);
});

test("streamSimple forwards the config turn caps to the driver", async () => {
	const prevTurn = process.env.AGY_TURN_TIMEOUT_MIN;
	const prevIdle = process.env.AGY_INACTIVITY_TIMEOUT_MIN;
	try {
		process.env.AGY_TURN_TIMEOUT_MIN = "45";
		process.env.AGY_INACTIVITY_TIMEOUT_MIN = "5";
		const entry = { full: "gemini-3.6-flash", id: "gemini-flash" };
		const opts = await captureTurn(entry, undefined);
		assert.equal(opts?.timeoutMin, 45);
		assert.equal(opts?.inactivityMin, 5);
		// 0 = disable: the value must reach the driver verbatim, not fall back
		// to the driver-side default of 10.
		process.env.AGY_TURN_TIMEOUT_MIN = "0";
		const disabled = await captureTurn(entry, undefined);
		assert.equal(disabled?.timeoutMin, 0);
		// Unset: the TTY-aware default resolves (vitest stdio is piped: 20).
		delete process.env.AGY_TURN_TIMEOUT_MIN;
		const fallback = await captureTurn(entry, undefined);
		assert.equal(fallback?.timeoutMin, 20);
		assert.equal(fallback?.inactivityMin, 5);
	} finally {
		if (prevTurn === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prevTurn;
		if (prevIdle === undefined) delete process.env.AGY_INACTIVITY_TIMEOUT_MIN;
		else process.env.AGY_INACTIVITY_TIMEOUT_MIN = prevIdle;
	}
});

/** Context with a prior foreign-provider assistant turn, so the G1 digest
 *  has real content to deliver (buildContextDigest skips the current prompt). */
function digestContext(): TranscriptContext {
	return normalizeContext({
		systemPrompt: undefined,
		messages: [
			{ role: "user", content: "earlier", timestamp: Date.now() },
			{
				role: "assistant",
				provider: "claude",
				content: [{ type: "text", text: "claude says hi" }],
				timestamp: Date.now(),
				model: "claude-sonnet-4-6",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				api: "anthropic-messages",
			},
			{ role: "user", content: "current", timestamp: Date.now() },
		],
	});
}

test("streamSimple: acp engine ships the digest as a contextBlock, not inline", async () => {
	process.env.AGY_ENGINE = "acp";
	process.env.AGY_DIGEST = "1";
	try {
		const seen: { opts?: DriverTurnRequest } = {};
		const driver = capturingDriver(seen);
		const streamSimple = createStreamSimple({
			entries: [{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] }],
			store: new SessionStore(tmpStorePath()),
			driver,
			acpDriver: driver,
			roundTrips: new ToolRoundTrips(driver),
		});
		const stream = streamSimple(
			{ ...model, id: "gemini-flash" },
			digestContext(),
			{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
		);
		for await (const ev of stream) void ev;
		// Digest rides as the embeddedContext resource block...
		assert.ok(seen.opts?.contextBlock, "contextBlock present");
		assert.equal(seen.opts.contextBlock.uri, "urn:pi-bridge:context-digest/3");
		// The digest block carries the framing preamble INTO the resource: an
		// unlabeled blob of other-agent turns is a mild injection surface.
		assert.ok(seen.opts.contextBlock.text.includes("context from the broader pi session"));
		assert.ok(seen.opts.contextBlock.text.includes("claude says hi"));
		// ...and stays out of the prompt text (no inline preamble).
		assert.equal(seen.opts.prompt, "current");
	} finally {
		delete process.env.AGY_ENGINE;
		delete process.env.AGY_DIGEST;
	}
});

test("streamSimple: stream-json engine keeps the digest inline in the prompt", async () => {
	process.env.AGY_ENGINE = "stream-json";
	process.env.AGY_DIGEST = "1";
	try {
		// Two distinct drivers: production wiring never shares one instance
		// between the driver and acpDriver roles, and the engine heuristic
		// keys off object identity.
		const seen: { opts?: DriverTurnRequest } = {};
		const streamSeen: { opts?: DriverTurnRequest } = {};
		const streamDriver = capturingDriver(streamSeen);
		const acpSeen: { opts?: DriverTurnRequest } = {};
		const acpOnlyDriver = capturingDriver(acpSeen);
		const streamSimple = createStreamSimple({
			entries: [{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] }],
			store: new SessionStore(tmpStorePath()),
			driver: streamDriver,
			acpDriver: acpOnlyDriver,
			roundTrips: new ToolRoundTrips(streamDriver),
		});
		const stream = streamSimple(
			{ ...model, id: "gemini-flash" },
			digestContext(),
			{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
		);
		for await (const ev of stream) void ev;
		assert.match(streamSeen.opts?.prompt ?? "", /context from the broader pi session/);
		assert.match(streamSeen.opts?.prompt ?? "", /claude says hi/);
		assert.equal(streamSeen.opts?.contextBlock, undefined);
		assert.equal(acpSeen.opts, undefined, "acp driver must not run");
	} finally {
		delete process.env.AGY_ENGINE;
		delete process.env.AGY_DIGEST;
	}
});

// Fixed timestamps for the multi-turn handoff tests: the boundary
// fingerprint is role+timestamp, so turn 2 must control them exactly.
const T0 = 1_700_000_000_000;

function msgContext(msgs: unknown[]): TranscriptContext {
	return normalizeContext({ systemPrompt: undefined, messages: msgs } as never);
}

function antigravityAsst(text: string, timestamp: number): unknown {
	return {
		role: "assistant",
		provider: "antigravity",
		content: [{ type: "text", text }],
		timestamp,
		model: "gemini-flash",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		api: "anthropic-messages",
	};
}

/** One streamSimple wired on the default (acp) engine: a single capturing
 *  driver doubles as the acp driver (the engine heuristic keys off object
 *  identity). Optional conversationId binds session records across turns. */
function defaultEngineStreamSimple(store: SessionStore, seen: { opts?: DriverTurnRequest }, conversationId?: string) {
	const driver = capturingDriver(seen, conversationId);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] }],
		store,
		driver,
		acpDriver: driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	return (ctx: TranscriptContext) =>
		streamSimple({ ...model, id: "gemini-flash" }, ctx, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
}

async function drain(stream: ReturnType<ReturnType<typeof createStreamSimple>>): Promise<void> {
	for await (const ev of stream) void ev;
}

test("streamSimple: default config ships the digest to a fresh conversation (model-switch handoff)", async () => {
	// The reported bug: pi hands a bridge model a transcript agy was never
	// spawned for, and with the digest off by default the fresh conversation
	// received only the latest prompt ("ok, ready for the task").
	const seen: { opts?: DriverTurnRequest } = {};
	const turn = defaultEngineStreamSimple(new SessionStore(tmpStorePath()), seen);
	await drain(turn(digestContext()));
	assert.ok(seen.opts?.contextBlock, "handoff digest must ride the contextBlock with default config");
	assert.match(seen.opts.contextBlock.text, /claude says hi/);
	assert.equal(seen.opts.prompt, "current");
});

test("streamSimple: a transcript mutated under the watermark resets the digest to the full delta", async () => {
	// /tree and /fork rewrite history below the stored count; the stale
	// boundary fingerprint must fall back to the full delta (the branched
	// user message ships; the own antigravity turn stays skipped) instead of
	// a silently wrong window.
	const seen: { opts?: DriverTurnRequest } = {};
	const store = new SessionStore(tmpStorePath());
	const turn = defaultEngineStreamSimple(store, seen, "conv-fp");
	await drain(turn(msgContext([{ role: "user", content: "hello", timestamp: T0 }])));
	assert.ok(seen.opts, "turn 1 ran");
	await drain(
		turn(
			msgContext([
				{ role: "user", content: "branched", timestamp: T0 + 5 },
				antigravityAsst("own answer", T0 + 6),
				{ role: "user", content: "current", timestamp: T0 + 7 },
			]),
		),
	);
	assert.match(seen.opts?.contextBlock?.text ?? "", /branched/);
});

test("streamSimple: pure-agy steady state ships no digest (prompt cache stays intact)", async () => {
	// Turn 2 appends only agy's own answer and the new prompt: an empty delta
	// must produce no digest block and a byte-identical prompt. AGY_DIGEST=1
	// isolates this gate contract from the default flip.
	process.env.AGY_DIGEST = "1";
	try {
		const seen: { opts?: DriverTurnRequest } = {};
		const store = new SessionStore(tmpStorePath());
		const turn = defaultEngineStreamSimple(store, seen, "conv-steady");
		await drain(turn(msgContext([{ role: "user", content: "hello", timestamp: T0 }])));
		assert.ok(seen.opts, "turn 1 ran");
		await drain(
			turn(
				msgContext([
					{ role: "user", content: "hello", timestamp: T0 },
					antigravityAsst("own answer", T0 + 1),
					{ role: "user", content: "current", timestamp: T0 + 2 },
				]),
			),
		);
		assert.equal(seen.opts?.contextBlock, undefined);
		assert.equal(seen.opts?.prompt, "current");
	} finally {
		delete process.env.AGY_DIGEST;
	}
});

test("streamSimple forwards options.reasoning as effort for an effort-driven base", async () => {
	const opts = await captureTurn(
		{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] },
		"high",
	);
	assert.equal(opts?.model, "gemini-3.6-flash");
	assert.equal(opts?.effort, "high");
});

test("streamSimple clamps an unsupported tier to the base's nearest effort", async () => {
	const opts = await captureTurn(
		{ full: "gemini-3.1-pro", id: "pro", efforts: ["low", "high"] },
		// medium is not valid for Pro (hidden in the toggle); provider clamps to high.
		"medium",
	);
	assert.equal(opts?.model, "gemini-3.1-pro");
	assert.equal(opts?.effort, "high");
});

test("streamSimple omits effort for a fixed (non-effort) model", async () => {
	const opts = await captureTurn({ full: "claude-sonnet-4-6", id: "claude-sonnet" }, "high");
	assert.equal(opts?.model, "claude-sonnet-4-6");
	assert.equal(opts?.effort, undefined);
});

test("Gate C: consumeActivity parks for native-tools on stream-json engine", () => {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "agy-bridge" as Api,
		provider: "antigravity",
		model: "gemini-flash",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const blocks = { partial, textIdx: null, thinkingIdx: null, started: false };
	const diffCtx = new TurnDiffContext({ toplevel: () => null, showHead: () => null });
	const driver = capturingDriver({});
	const roundTrips = new ToolRoundTrips(driver);
	const replay = new WrapperReplay();

	const res = consumeActivity(
		stream,
		blocks,
		{ type: "tool_done", name: "view_file", args: { path: "/test.ts" } },
		diffCtx,
		process.cwd(),
		{ replay, roundTrips, nativeActive: () => true, engine: "stream-json" },
	);
	assert.equal(res, "parked");
	assert.equal(partial.stopReason, "toolUse");
});

test("Gate C: consumeActivity skips native re-exec and wrapper replay on ACP engine", () => {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "agy-bridge" as Api,
		provider: "antigravity",
		model: "gemini-flash",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const blocks = { partial, textIdx: null, thinkingIdx: null, started: false };
	const diffCtx = new TurnDiffContext({ toplevel: () => null, showHead: () => null });
	const driver = capturingDriver({});
	const roundTrips = new ToolRoundTrips(driver);
	const replay = new WrapperReplay();

	const res = consumeActivity(
		stream,
		blocks,
		{ type: "tool_done", name: "view_file", args: { path: "/test.ts" } },
		diffCtx,
		process.cwd(),
		{ replay, roundTrips, nativeActive: () => true, engine: "acp" },
	);
	assert.equal(res, "continue");
	assert.equal(partial.stopReason, "stop");
	assert.ok(partial.content.some((b) => b.type === "thinking" && b.thinking.includes("[agy tool: view_file]")));
});

test("streamSimple: legacy records without a boundary fingerprint keep their watermark", () => {
	return (async () => {
		// Records written before the digest fix carry lastMessageCount but no
		// digestBoundary. Trusting the count avoids a one-time full-delta dump
		// of history agy already holds; the settle below populates the new
		// fields.
		const seen: { opts?: DriverTurnRequest } = {};
		const store = new SessionStore(tmpStorePath());
		store.set(sessionKey(undefined, process.cwd(), "acp"), {
			conversationId: "conv-legacy",
			lastStepIdx: -1,
			lastMessageCount: 2,
		});
		const turn = defaultEngineStreamSimple(store, seen, "conv-legacy");
		await drain(
			turn(
				msgContext([
					{ role: "user", content: "covered1", timestamp: T0 },
					antigravityAsst("own answer", T0 + 1),
					{ role: "user", content: "current", timestamp: T0 + 2 },
				]),
			),
		);
		assert.equal(seen.opts?.contextBlock, undefined, "watermark-covered legacy record must ship no digest");
		const rec = store.get(sessionKey(undefined, process.cwd(), "acp"));
		assert.ok(rec?.digestBoundary, "settle must populate the fingerprint");
	})();
});

/** Stream-json wiring: two distinct capturing drivers (the engine heuristic
 *  keys off object identity; production never shares one instance). */
function streamJsonWiring(store: SessionStore, promptSeen: { opts?: DriverTurnRequest }) {
	const acpSeen: { opts?: DriverTurnRequest } = {};
	const streamDriver = capturingDriver(promptSeen);
	const acpOnlyDriver = capturingDriver(acpSeen);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] }],
		store,
		driver: streamDriver,
		acpDriver: acpOnlyDriver,
		roundTrips: new ToolRoundTrips(streamDriver),
	});
	return (ctx: TranscriptContext) =>
		streamSimple({ ...model, id: "gemini-flash" }, ctx, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
}

test("streamSimple: stream-json budgets the prompt in bytes, not chars", () => {
	return (async () => {
		// 12000 CJK chars = ~36KB of prompt bytes: the prompt ALONE crosses the
		// ~25KB silent-drop cap, so a char-based budget (25000 - 12000 - 4096
		// -> 8000-char digest) would ship a doomed turn. The digest must skip.
		const cjk = "漢".repeat(12_000);
		process.env.AGY_ENGINE = "stream-json";
		process.env.AGY_DIGEST = "1";
		try {
			const seen: { opts?: DriverTurnRequest } = {};
			const turn = streamJsonWiring(new SessionStore(tmpStorePath()), seen);
			await drain(
				turn(
					msgContext([
						{ role: "user", content: "earlier", timestamp: T0 },
						{
							role: "assistant",
							provider: "claude",
							content: [{ type: "text", text: "claude says hi" }],
							timestamp: T0 + 1,
							model: "claude-sonnet-4-6",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, total: 0 } },
							stopReason: "stop",
							api: "anthropic-messages",
						},
						{ role: "user", content: cjk, timestamp: T0 + 2 },
					]),
				),
			);
			assert.doesNotMatch(seen.opts?.prompt ?? "", /context from the broader pi session/);
			// The over-cap run is hard-sliced with a visible marker (issue #24
			// prompt guard) instead of shipping a silently dropped turn.
			const delivered = seen.opts?.prompt ?? "";
			assert.ok(delivered.startsWith("[truncated]"), "over-cap prompt truncates visibly");
			assert.ok(delivered.includes("漢"), "the sliced head keeps the prompt intent");
			assert.ok(Buffer.byteLength(delivered, "utf8") <= 25_000, "the delivered prompt fits the cap");
		} finally {
			delete process.env.AGY_ENGINE;
			delete process.env.AGY_DIGEST;
		}
	})();
});

test("streamSimple: stream-json skips the digest when its own bytes blow the budget", () => {
	return (async () => {
		// ASCII prompt (15000 bytes) + a CJK foreign turn (~3000 chars but
		// ~9000 bytes): the char budget (5904) admits the digest, the byte
		// budget does not. Fail closed: ship no digest rather than a dropped
		// turn.
		const claudeCjk = "字".repeat(3_000);
		process.env.AGY_ENGINE = "stream-json";
		process.env.AGY_DIGEST = "1";
		try {
			const seen: { opts?: DriverTurnRequest } = {};
			const turn = streamJsonWiring(new SessionStore(tmpStorePath()), seen);
			await drain(
				turn(
					msgContext([
						{ role: "user", content: "earlier", timestamp: T0 },
						{
							role: "assistant",
							provider: "claude",
							content: [{ type: "text", text: claudeCjk }],
							timestamp: T0 + 1,
							model: "claude-sonnet-4-6",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, total: 0 } },
							stopReason: "stop",
							api: "anthropic-messages",
						},
						{ role: "user", content: "x".repeat(15_000), timestamp: T0 + 2 },
					]),
				),
			);
			assert.doesNotMatch(seen.opts?.prompt ?? "", /context from the broader pi session/);
		} finally {
			delete process.env.AGY_ENGINE;
			delete process.env.AGY_DIGEST;
		}
	})();
});
