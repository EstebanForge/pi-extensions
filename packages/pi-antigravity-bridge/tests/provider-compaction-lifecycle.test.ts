// Compaction & silent-overflow lifecycle tests for pi-antigravity-bridge:
//
//   1. Phantom silent-overflow prevention (follow-up to issue #12):
//      pi-ai's isContextOverflow() Case 2 checks `usage.input + usage.cacheRead
//      > contextWindow` on stopReason === "stop". Multi-step billing sums can
//      exceed contextWindow even when live occupancy (totalTokens) is well
//      inside the window; clampOverflowUsage scales input + cacheRead down
//      proportionally while leaving normal turns and genuine overflows alone.
//   2. Ephemeral helper turn isolation (options.cacheRetention === "none"):
//      pi's compaction and branch summarization pass cacheRetention: "none".
//      Those calls must run in a fresh agy conversation without reading,
//      mutating, or deleting the live SessionStore binding, claiming stranded
//      tool results, or arming background-task watchers.
//   3. Post-compaction rotation & handoff:
//      rotateSessionOnCompaction drops the bound agy conversation so backend
//      context is freed alongside pi's transcript, guarantees a one-shot
//      compaction handoff even when config.digest is disabled, and handles
//      mid-tool-loop compacted tails (toolResult/assistant) via
//      COMPACTION_RESUME_PROMPT + includeLast instead of hard-erroring.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "vitest";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import {
	normalizeContext,
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	COMPACTION_RESUME_PROMPT,
	DIGEST_PREAMBLE,
	ToolRoundTrips,
	buildContextDigest,
	createStreamSimple,
	rotateSessionOnCompaction,
	sessionKey,
} from "../src/provider.js";
import { clampOverflowUsage } from "../src/stream-events.js";
import { SessionStore } from "../src/sessions.js";
import type { StreamDriver, DriverTurnRequest } from "../src/driver.js";
import type { DriverActivity, TurnHandle, TurnOutcome } from "../src/driver-types.js";

// Isolate loadConfig() from any live agent dir on the test runner's machine
// (matches tests/provider-streaming.test.ts).
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
const fakeAgentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-compact-home-"));
process.env.PI_CODING_AGENT_DIR = path.join(fakeAgentRoot, ".pi", "agent");
afterAll(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	fs.rmSync(fakeAgentRoot, { recursive: true, force: true });
});

const COMP_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMP_SUFFIX = "\n</summary>";

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

function user(content: string, timestamp = 1000): Message {
	return { role: "user", content, timestamp };
}

function compaction(summary: string, timestamp = 2000): Message {
	return user(COMP_PREFIX + summary + COMP_SUFFIX, timestamp);
}

function assistantMsg(text: string, provider = "antigravity", timestamp = 3000): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "agy-bridge" as never,
		provider: provider as never,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp,
	};
}

function toolResultMsg(toolCallId: string, toolName: string, text: string, timestamp = 4000): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
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

async function drainTerminal(
	stream: ReturnType<ReturnType<typeof createStreamSimple>>,
): Promise<{ type: "done" | "error"; message: AssistantMessage }> {
	for await (const ev of stream) {
		if (ev.type === "done") return { type: "done", message: ev.message };
		if (ev.type === "error") return { type: "error", message: ev.error };
	}
	throw new Error("stream ended without a terminal event");
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

describe("clampOverflowUsage and pi-ai silent-overflow parity", () => {
	test("proportionally clamps multi-inference billing sums that exceed contextWindow", () => {
		const usage = { input: 400_000, output: 20_000, cacheRead: 3_600_000, totalTokens: 280_000 };
		clampOverflowUsage(usage, 1_000_000);

		assert.equal(usage.input, 26_000);
		assert.equal(usage.cacheRead, 234_000);
		assert.equal(usage.input + usage.cacheRead, 260_000);
		assert.equal(usage.input + usage.cacheRead + usage.output, 280_000);
		assert.equal(usage.totalTokens, 280_000);

		const msg = {
			role: "assistant",
			stopReason: "stop",
			usage: { ...zeroUsage(), ...usage },
		} as AssistantMessage;
		assert.equal(isContextOverflow(msg, 1_000_000), false);
	});

	test("leaves normal turns below contextWindow untouched", () => {
		const usage = { input: 1000, output: 50, cacheRead: 800, totalTokens: 1450 };
		clampOverflowUsage(usage, 1_000_000);
		assert.deepEqual(usage, { input: 1000, output: 50, cacheRead: 800, totalTokens: 1450 });
	});

	test("preserves genuine silent overflow when totalTokens exceeds contextWindow", () => {
		const usage = { input: 300_000, output: 10_000, cacheRead: 900_000, totalTokens: 1_150_000 };
		clampOverflowUsage(usage, 1_000_000);
		assert.deepEqual(usage, { input: 300_000, output: 10_000, cacheRead: 900_000, totalTokens: 1_150_000 });

		const msg = {
			role: "assistant",
			stopReason: "stop",
			usage: { ...zeroUsage(), ...usage },
		} as AssistantMessage;
		assert.equal(isContextOverflow(msg, 1_000_000), true);
	});

	test("handles exact boundary (totalTokens === contextWindow) without rounding overshoot", () => {
		const usage = { input: 333_333, output: 0, cacheRead: 1_666_667, totalTokens: 1_000_000 };
		clampOverflowUsage(usage, 1_000_000);
		assert.equal(usage.input + usage.cacheRead, 1_000_000);

		const msg = {
			role: "assistant",
			stopReason: "stop",
			usage: { ...zeroUsage(), ...usage },
		} as AssistantMessage;
		assert.equal(isContextOverflow(msg, 1_000_000), false);
	});

	test("handles output >= totalTokens without producing negative values", () => {
		const usage = { input: 800_000, output: 50_000, cacheRead: 800_000, totalTokens: 40_000 };
		clampOverflowUsage(usage, 1_000_000);
		assert.equal(usage.input, 20_000);
		assert.equal(usage.cacheRead, 20_000);
		assert.equal(usage.input + usage.cacheRead, 40_000);
	});

	test("provider clamps multi-step usage on finalized stop turns (ACP & stream-json)", async () => {
		for (const engine of ["acp", "stream-json"] as const) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-overflow-"));
			try {
				const requests: DriverTurnRequest[] = [];
				const driver = makeFakeDriver(
					[
						{
							outcome: okOutcome("conv-1"),
							activities: [
								{
									type: "usage",
									usage: {
										input_tokens: 500_000,
										output_tokens: 15_000,
										cache_read_tokens: 4_500_000,
										total_tokens: 215_000,
									},
								},
								{ type: "text", delta: "done" },
							],
						},
					],
					requests,
				);
				const store = new SessionStore(path.join(dir, "sessions.json"));
				const streamSimple = createStreamSimple({
					entries: [{ id: model.id, full: "gemini-3.8-flash" }],
					store,
					driver,
					...(engine === "acp" ? { acpDriver: driver, engine } : { engine }),
					roundTrips: new ToolRoundTrips(driver),
				});
				const terminal = await drainTerminal(
					streamSimple(
						model,
						normalizeContext({ messages: [user("run tests")] }),
						{ cwd: dir, sessionId: "s-overflow" } as unknown as SimpleStreamOptions,
					),
				);
				assert.equal(terminal.type, "done");
				assert.equal(isContextOverflow(terminal.message, model.contextWindow), false);
				assert.equal(terminal.message.usage.totalTokens, 215_000);
				assert.equal(terminal.message.usage.input + terminal.message.usage.cacheRead, 200_000);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	});
});

describe("ephemeral turn isolation (cacheRetention: 'none')", () => {
	test("does not persist throwaway summarization session IDs to SessionStore", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ephemeral-"));
		try {
			const requests: DriverTurnRequest[] = [];
			const driver = makeFakeDriver([{ outcome: okOutcome("conv-throwaway", "summary") }], requests);
			const store = new SessionStore(path.join(dir, "sessions.json"));
			const streamSimple = createStreamSimple({
				entries: [{ id: model.id, full: "gemini-3.8-flash" }],
				store,
				driver,
				acpDriver: driver,
				engine: "acp",
				roundTrips: new ToolRoundTrips(driver),
			});

			const terminal = await drainTerminal(
				streamSimple(
					model,
					normalizeContext({ systemPrompt: "Summarize conversation.", messages: [user("transcript")] }),
					{ cwd: dir, sessionId: "random-uuidv7", cacheRetention: "none" } as unknown as SimpleStreamOptions,
				),
			);
			assert.equal(terminal.type, "done");
			assert.equal(requests[0]?.conversationId, null);
			assert.equal(store.size, 0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("runs fresh without reading, mutating, or deleting a live bound session or arming background watchers", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ephemeral-live-"));
		try {
			const requests: DriverTurnRequest[] = [];
			const backgroundArms: Array<{ conversationId: string; turnStartMs: number }> = [];
			const driver = makeFakeDriver(
				[
					{ outcome: okOutcome("conv-live", "turn 1") },
					{
						outcome: okOutcome("conv-summary", "compacted summary"),
						activities: [
							{
								type: "tool_start",
								name: "run_command",
								args: { CommandLine: "sleep 1", WaitMsBeforeAsync: 500 },
							},
							{ type: "text", delta: "compacted summary" },
						],
					},
					// Simulate an ephemeral silent-drop failure: must not delete the live binding.
					{
						outcome: {
							status: "OK",
							response: "",
							finished: true,
							aborted: false,
							conversationId: "conv-drop",
							modelOutputSeen: false,
							sawResult: true,
						},
					},
					{ outcome: okOutcome("conv-live", "turn 2") },
				],
				requests,
			);
			const store = new SessionStore(path.join(dir, "sessions.json"));
			const rt = new ToolRoundTrips(driver);
			const streamSimple = createStreamSimple({
				entries: [{ id: model.id, full: "gemini-3.8-flash" }],
				store,
				driver,
				acpDriver: driver,
				engine: "acp",
				roundTrips: rt,
				onNativeBackground: (info) => backgroundArms.push(info),
			});
			const baseOpts = { cwd: dir, sessionId: "live-sess" } as unknown as SimpleStreamOptions;
			const key = sessionKey(baseOpts, dir, "acp");

			// Turn 1 binds conv-live.
			await drainTerminal(streamSimple(model, normalizeContext({ messages: [user("hello")] }), baseOpts));
			assert.equal(store.get(key)?.conversationId, "conv-live");
			const originalWatermark = store.get(key)?.lastMessageCount;

			// Ephemeral summarization with the SAME sessionId must start fresh and leave the binding alone.
			const sumTerminal = await drainTerminal(
				streamSimple(
					model,
					normalizeContext({ systemPrompt: "Summarize", messages: [user("summarize this")] }),
					{ ...baseOpts, cacheRetention: "none" } as unknown as SimpleStreamOptions,
				),
			);
			assert.equal(sumTerminal.type, "done");
			assert.equal(requests[1]?.conversationId, null);
			assert.equal(store.get(key)?.conversationId, "conv-live");
			assert.equal(store.get(key)?.lastMessageCount, originalWatermark);
			assert.equal(backgroundArms.length, 0);

			// Ephemeral silent-drop (tested via disableContinuation: true) must NOT clear the live binding.
			const dropTerminal = await drainTerminal(
				streamSimple(
					model,
					normalizeContext({ messages: [user("huge summarization prompt")] }),
					{ ...baseOpts, disableContinuation: true } as unknown as SimpleStreamOptions,
				),
			);
			assert.equal(dropTerminal.type, "error");
			assert.equal(store.get(key)?.conversationId, "conv-live");

			// Next real turn still resumes conv-live cleanly.
			await drainTerminal(
				streamSimple(model, normalizeContext({ messages: [user("hello"), user("follow-up")] }), baseOpts),
			);
			assert.equal(requests[3]?.conversationId, "conv-live");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ephemeral turn does not steal a live session's dead park tombstone or stranded escalation", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ephemeral-late-"));
		try {
			const requests: DriverTurnRequest[] = [];
			const activeHandle = {
				id: "parked-turn",
				outcome: new Promise<never>(() => {}),
				next: async () => null,
				pushExternal: () => {},
			};
			const driver = {
				get activeHandle() {
					return activeHandle;
				},
				kickIdle: () => {},
				reentry: () => null,
				snapshot: () => ({ state: "ready", conversationId: "conv-live", stats: {} }),
				run: async (opts: DriverTurnRequest) => {
					requests.push(opts);
					return {
						id: `fake-turn-${requests.length}`,
						outcome: Promise.resolve(okOutcome(opts.conversationId ?? "conv-new", "ok")),
						next: async () => null,
						pushExternal: () => {},
					} satisfies TurnHandle as unknown as TurnHandle;
				},
			} as unknown as StreamDriver;

			const store = new SessionStore(path.join(dir, "sessions.json"));
			const rt = new ToolRoundTrips(driver, undefined, { escalateAfterMs: 1 });
			const opts = { cwd: dir, sessionId: "late-sess" } as unknown as SimpleStreamOptions;
			const key = sessionKey(opts, dir, "acp");
			store.set(key, { conversationId: "conv-live", lastStepIdx: -1, lastMessageCount: 1 });

			// Create a dead park tombstone (aborted/expired park whose tool result hasn't arrived yet).
			const deadSettled = rt
				.onToolCall("dead-call-1", "AskClaude", {}, new AbortController().signal)
				.then(
					() => "resolved",
					() => "rejected",
				);
			rt.failAll("expired");
			await deadSettled;
			assert.deepEqual(rt.deadIds, ["dead-call-1"]);

			// Create a done-but-undelivered escalated call.
			const esc = await rt.onToolCall("esc-call-1", "ask_user_question", {}, new AbortController().signal);
			assert.equal("escalated" in esc && esc.escalated, true);
			rt.stampConversation("conv-live");
			rt.resolve("esc-call-1", "user answered yes", false);

			const streamSimple = createStreamSimple({
				entries: [{ id: model.id, full: "gemini-3.8-flash" }],
				store,
				driver,
				acpDriver: driver,
				engine: "acp",
				roundTrips: rt,
			});

			// Ephemeral summarization turn must NOT claim either the dead tombstone or the stranded escalation.
			const ephTerminal = await drainTerminal(
				streamSimple(
					model,
					normalizeContext({
						systemPrompt: "Summarize",
						messages: [toolResultMsg("dead-call-1", "AskClaude", "LATE"), user("summarize")],
					}),
					{ ...opts, cacheRetention: "none" } as unknown as SimpleStreamOptions,
				),
			);
			assert.equal(ephTerminal.type, "done");
			assert.equal(requests[0]?.conversationId, null);
			assert.equal(requests[0]?.prompt.includes("Late tool delivery"), false);
			assert.deepEqual(rt.deadIds, ["dead-call-1"]);

			// The next real turn claims and delivers both cleanly into conv-live.
			const realTerminal = await drainTerminal(
				streamSimple(
					model,
					normalizeContext({
						messages: [toolResultMsg("dead-call-1", "AskClaude", "LATE"), user("continue")],
					}),
					opts,
				),
			);
			assert.equal(realTerminal.type, "done");
			assert.equal(requests[1]?.conversationId, "conv-live");
			assert.match(requests[1]?.prompt ?? "", /Late tool delivery/);
			assert.match(requests[1]?.prompt ?? "", /LATE/);
			assert.match(requests[1]?.prompt ?? "", /user answered yes/);
			assert.deepEqual(rt.deadIds, []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("post-compaction session rotation and handoff", () => {
	test("rotateSessionOnCompaction clears bound key and returns rotated conversation id", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-rotate-"));
		try {
			const store = new SessionStore(path.join(dir, "sessions.json"));
			const handoff = new Set<string>();
			const key = "sid:s1@acp";

			assert.equal(rotateSessionOnCompaction(store, key, handoff), null);
			assert.equal(handoff.has(key), false);

			store.set(key, { conversationId: "conv-old", lastStepIdx: -1, lastMessageCount: 10 });
			assert.equal(rotateSessionOnCompaction(store, key, handoff), "conv-old");
			assert.equal(store.get(key), null);
			assert.equal(handoff.has(key), true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rotates to a fresh agy conversation and delivers compaction summary once even with AGY_DIGEST=0", async () => {
		await withEnv({ AGY_DIGEST: "0", AGY_SYSTEM_PROMPT: "off" }, async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-compact-handoff-"));
			try {
				const requests: DriverTurnRequest[] = [];
				const driver = makeFakeDriver(
					[
						{ outcome: okOutcome("conv-old", "before compact") },
						// First post-compaction attempt fails: handoff must survive for the retry.
						{
							outcome: {
								status: "ERROR",
								response: "",
								error: "transient failure",
								finished: true,
								aborted: false,
								conversationId: "conv-failed",
							},
						},
						{ outcome: okOutcome("conv-fresh", "after compact") },
						{ outcome: okOutcome("conv-fresh", "steady state") },
					],
					requests,
				);
				const store = new SessionStore(path.join(dir, "sessions.json"));
				const handoff = new Set<string>();
				const streamSimple = createStreamSimple({
					entries: [{ id: model.id, full: "gemini-3.8-flash" }],
					store,
					driver,
					acpDriver: driver,
					engine: "acp",
					roundTrips: new ToolRoundTrips(driver),
					pendingCompactionHandoff: handoff,
				});
				const opts = { cwd: dir, sessionId: "compact-sess" } as unknown as SimpleStreamOptions;
				const key = sessionKey(opts, dir, "acp");

				// Turn 1 binds conv-old.
				await drainTerminal(streamSimple(model, normalizeContext({ messages: [user("initial task")] }), opts));
				assert.equal(store.get(key)?.conversationId, "conv-old");

				// Simulate pi session_compact hook.
				assert.equal(rotateSessionOnCompaction(store, key, handoff), "conv-old");

				const compactedCtx: TranscriptContext = normalizeContext({
					messages: [compaction("Key decision: keep SQLite schema v2."), user("continue task")],
				});

				// Failed attempt starts fresh with the summary and preserves handoff for retry.
				const failed = await drainTerminal(streamSimple(model, compactedCtx, opts));
				assert.equal(failed.type, "error");
				assert.equal(requests[1]?.conversationId, null);
				assert.match(requests[1]?.contextBlock?.text ?? "", /keep SQLite schema v2/);
				assert.equal(handoff.has(key), true);

				// Retry succeeds in a fresh conversation, binds conv-fresh, and clears the one-shot handoff.
				const recovered = await drainTerminal(streamSimple(model, compactedCtx, opts));
				assert.equal(recovered.type, "done");
				assert.equal(requests[2]?.conversationId, null);
				assert.match(requests[2]?.contextBlock?.text ?? "", /keep SQLite schema v2/);
				assert.equal(store.get(key)?.conversationId, "conv-fresh");
				assert.equal(handoff.has(key), false);

				// Steady-state turn with AGY_DIGEST=0 resumes conv-fresh with no digest.
				await drainTerminal(
					streamSimple(
						model,
						normalizeContext({
							messages: [
								compaction("Key decision: keep SQLite schema v2."),
								user("continue task"),
								assistantMsg("after compact"),
								user("next question"),
							],
						}),
						opts,
					),
				);
				assert.equal(requests[3]?.conversationId, "conv-fresh");
				assert.equal(requests[3]?.contextBlock, undefined);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	test("buildContextDigest with includeLast: true preserves trailing toolResult after compaction", () => {
		const msgs = [
			compaction("Finished step 1"),
			assistantMsg("Running build check"),
			toolResultMsg("call-9", "bash", "tests passed: 42"),
		];
		const digest = buildContextDigest(msgs, 0, { bound: false, includeLast: true });
		assert.match(digest, /Finished step 1/);
		assert.match(digest, /Running build check/);
		assert.match(digest, /\[tool result: bash\]/);
		assert.match(digest, /tests passed: 42/);
	});

	test("post-compaction mid-tool-loop tail resumes into a fresh conversation instead of hard-erroring", async () => {
		for (const engine of ["acp", "stream-json"] as const) {
			await withEnv({ AGY_DIGEST: "0", AGY_SYSTEM_PROMPT: "off" }, async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-compact-resume-"));
				try {
					const requests: DriverTurnRequest[] = [];
					const driver = makeFakeDriver(
						[{ outcome: okOutcome("conv-old") }, { outcome: okOutcome("conv-fresh") }],
						requests,
					);
					const store = new SessionStore(path.join(dir, "sessions.json"));
					const handoff = new Set<string>();
					const streamSimple = createStreamSimple({
						entries: [{ id: model.id, full: "gemini-3.8-flash" }],
						store,
						driver,
						...(engine === "acp" ? { acpDriver: driver, engine } : { engine }),
						roundTrips: new ToolRoundTrips(driver),
						pendingCompactionHandoff: handoff,
					});
					const opts = { cwd: dir, sessionId: `mid-loop-${engine}` } as unknown as SimpleStreamOptions;
					const key = sessionKey(opts, dir, engine);

					await drainTerminal(streamSimple(model, normalizeContext({ messages: [user("start")] }), opts));
					rotateSessionOnCompaction(store, key, handoff);

					const terminal = await drainTerminal(
						streamSimple(
							model,
							normalizeContext({
								messages: [
									compaction("Compacted progress up to tool call."),
									assistantMsg("Inspecting test output"),
									toolResultMsg("call-42", "bash", "3 failures in parser.test.ts"),
								],
							}),
							opts,
						),
					);
					assert.equal(terminal.type, "done");
					assert.equal(requests[1]?.conversationId, null);
					assert.equal(store.get(key)?.conversationId, "conv-fresh");
					assert.equal(handoff.has(key), false);

					if (engine === "acp") {
						assert.equal(requests[1]?.prompt, COMPACTION_RESUME_PROMPT);
						assert.match(requests[1]?.contextBlock?.text ?? "", /Compacted progress up to tool call/);
						assert.match(requests[1]?.contextBlock?.text ?? "", /3 failures in parser\.test\.ts/);
					} else {
						assert.ok(requests[1]?.prompt.includes(DIGEST_PREAMBLE));
						assert.ok(requests[1]?.prompt.includes("Compacted progress up to tool call"));
						assert.ok(requests[1]?.prompt.includes("3 failures in parser.test.ts"));
						assert.ok(requests[1]?.prompt.endsWith(COMPACTION_RESUME_PROMPT));
					}
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});
		}
	});

	test("unbound toolResult tail WITHOUT compaction still errors with 'No user message to send to agy.'", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-unbound-tail-"));
		try {
			const requests: DriverTurnRequest[] = [];
			const driver = makeFakeDriver([{ outcome: okOutcome("conv-unused") }], requests);
			const store = new SessionStore(path.join(dir, "sessions.json"));
			const streamSimple = createStreamSimple({
				entries: [{ id: model.id, full: "gemini-3.8-flash" }],
				store,
				driver,
				acpDriver: driver,
				engine: "acp",
				roundTrips: new ToolRoundTrips(driver),
			});
			const terminal = await drainTerminal(
				streamSimple(
					model,
					normalizeContext({
						messages: [user("do task"), assistantMsg("calling"), toolResultMsg("call-1", "bash", "ok")],
					}),
					{ cwd: dir, sessionId: "never-bound" } as unknown as SimpleStreamOptions,
				),
			);
			assert.equal(terminal.type, "error");
			assert.equal(terminal.message.errorMessage, "No user message to send to agy.");
			assert.equal(requests.length, 0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
