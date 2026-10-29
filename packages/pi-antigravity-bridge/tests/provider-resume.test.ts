// Resume turns (issue #8): when pi retries after a failed attempt, pi core
// drops the failed attempt from the projected context (context_edit with
// replacement:null, agent-session.js _omitRecoveryAttempt). The transcript
// then ends in a toolResult or assistant message with no live agy turn:
// extractUserPrompt returns null, nothing is pending or late, and the fresh
// pass used to hard-error "No user message to send to agy.", an error pi
// does not retry, stalling unattended sessions for hours. With a bound
// conversation, agy already holds the task history, so the provider must
// re-open it with a synthetic resume prompt instead.
//
// Run: npm test

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
import {
	ToolRoundTrips,
	createStreamSimple,
	DIGEST_PREAMBLE,
} from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type {
	StreamDriver,
	DriverActivity,
	DriverTurnRequest,
} from "../src/driver.js";

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
	return path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "agy-resume-")),
		"sessions.json",
	);
}

/** Fake driver whose OK outcome binds a conversation id, so the first turn
 *  establishes a binding the resume turn can re-open. */
function fakeDriver(
	seen: { opts?: DriverTurnRequest },
	conversationId?: string,
) {
	const fakeHandle = {
		id: "fake-turn",
		outcome: Promise.resolve({
			status: "OK" as const,
			response: "ok",
			finished: true,
			aborted: false,
			conversationId,
		}),
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

function toolResultMessage(
	callId: string,
	text: string,
	isError = false,
): Message {
	return {
		role: "toolResult",
		toolCallId: callId,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	} as unknown as Message;
}

function assistantMessage(text: string, provider = "antigravity"): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider,
		timestamp: Date.now(),
	} as unknown as Message;
}

function makeStreamSimple(
	driver: StreamDriver,
	rt: ToolRoundTrips,
	store: SessionStore,
	engine?: "stream-json" | "acp",
) {
	return createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver,
		...(engine === "acp" ? { acpDriver: driver, engine: "acp" as const } : {}),
		roundTrips: rt,
	});
}

async function collect(
	stream: ReturnType<ReturnType<typeof createStreamSimple>>,
): Promise<AssistantMessage[]> {
	const errors: AssistantMessage[] = [];
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	return errors;
}

const options = {
	cwd: process.cwd(),
	sessionId: "resume-test",
} as unknown as SimpleStreamOptions;

/** Run a binding turn (plain user message) so the store holds a conversation,
 *  then run the retry-shaped context against the same store. Returns the
 *  second pass's driver request and errors. */
async function bindThenRetry(
	engine: "stream-json" | "acp" | undefined,
	retryMessages: Message[],
	configure?: (env: NodeJS.ProcessEnv) => void,
): Promise<{ seen: { opts?: DriverTurnRequest }; errors: AssistantMessage[] }> {
	const seen: { opts?: DriverTurnRequest } = {};
	const store = new SessionStore(tmpStorePath());
	const rt = new ToolRoundTrips(fakeDriver(seen));
	const streamSimple = makeStreamSimple(
		fakeDriver(seen, "conv-1"),
		rt,
		store,
		engine,
	);

	const bindErrors = await collect(
		streamSimple(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{ role: "user", content: "do the task", timestamp: Date.now() },
				],
			}),
			options,
		),
	);
	assert.equal(bindErrors.length, 0);
	assert.equal(seen.opts?.conversationId, null); // fresh binding turn starts unbound
	seen.opts = undefined;

	if (configure) {
		configure(process.env);
		try {
			const errors = await collect(
				streamSimple(
					model,
					normalizeContext({
						systemPrompt: undefined,
						messages: retryMessages,
					}),
					options,
				),
			);
			return { seen, errors };
		} finally {
			delete process.env.AGY_DIGEST;
		}
	}
	const errors = await collect(
		streamSimple(
			model,
			normalizeContext({ systemPrompt: undefined, messages: retryMessages }),
			options,
		),
	);
	return { seen, errors };
}

test("resume: toolResult tail after a retry-dropped attempt re-opens the bound conversation", async () => {
	const { seen, errors } = await bindThenRetry(undefined, [
		{ role: "user", content: "do the task", timestamp: Date.now() } as Message,
		assistantMessage("let me call the tool"),
		toolResultMessage("call-x", "TOOL OUTPUT"),
	]);
	assert.equal(errors.length, 0);
	assert.ok(seen.opts, "driver.run was called");
	assert.equal(seen.opts.conversationId, "conv-1");
	assert.match(
		seen.opts.prompt,
		/previous attempt of this turn failed and was discarded/,
	);
	assert.match(seen.opts.prompt, /Do not repeat completed actions/);
	// The original user prompt is not re-sent.
	assert.equal(seen.opts.prompt.includes("do the task"), false);
});

test("resume: assistant tail also resumes", async () => {
	const { seen, errors } = await bindThenRetry(undefined, [
		{ role: "user", content: "do the task", timestamp: Date.now() } as Message,
		assistantMessage("partial answer before the failure"),
	]);
	assert.equal(errors.length, 0);
	assert.ok(seen.opts);
	assert.equal(seen.opts.conversationId, "conv-1");
	assert.match(
		seen.opts.prompt,
		/previous attempt of this turn failed and was discarded/,
	);
});

test("resume: same fix on the ACP engine", async () => {
	const { seen, errors } = await bindThenRetry("acp", [
		{ role: "user", content: "do the task", timestamp: Date.now() } as Message,
		assistantMessage("let me call the tool"),
		toolResultMessage("call-x", "TOOL OUTPUT"),
	]);
	assert.equal(errors.length, 0);
	assert.ok(seen.opts);
	assert.equal(seen.opts.conversationId, "conv-1");
	assert.match(
		seen.opts.prompt,
		/previous attempt of this turn failed and was discarded/,
	);
});

test("resume: without a bound conversation the hard error stays", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const store = new SessionStore(tmpStorePath());
	const rt = new ToolRoundTrips(fakeDriver(seen));
	const streamSimple = makeStreamSimple(fakeDriver(seen), rt, store);
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [
			{ role: "user", content: "do the task", timestamp: Date.now() },
			assistantMessage("let me call the tool"),
			toolResultMessage("call-x", "TOOL OUTPUT"),
		],
	});
	const errors = await collect(streamSimple(model, context, options));
	assert.equal(seen.opts, undefined);
	assert.equal(errors.length, 1);
	assert.equal(errors[0].errorMessage, "No user message to send to agy.");
});

test("resume: empty transcript still errors", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const store = new SessionStore(tmpStorePath());
	const rt = new ToolRoundTrips(fakeDriver(seen));
	const streamSimple = makeStreamSimple(fakeDriver(seen, "conv-1"), rt, store);
	// Bind first.
	await collect(
		streamSimple(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{ role: "user", content: "do the task", timestamp: Date.now() },
				],
			}),
			options,
		),
	);
	seen.opts = undefined;
	const errors = await collect(
		streamSimple(
			model,
			normalizeContext({ systemPrompt: undefined, messages: [] }),
			options,
		),
	);
	assert.equal(seen.opts, undefined);
	assert.equal(errors.length, 1);
	assert.equal(errors[0].errorMessage, "No user message to send to agy.");
});

/** Park a bridge call, then fail it the way the abort/timeout/recycle paths
 *  do, settling the park rejection. */
async function parkAndFail(
	rt: ToolRoundTrips,
	callId: string,
	name: string,
	reason: string,
): Promise<void> {
	const settled = rt
		.onToolCall(callId, name, {}, new AbortController().signal)
		.then(
			() => "resolved",
			(err: unknown) => (err instanceof Error ? err.message : "rejected"),
		);
	rt.failAll(reason);
	await settled;
}

test("resume: a late tool result present means no resume text (late delivery wins)", async () => {
	const seen1: { opts?: DriverTurnRequest } = {};
	const seen2: { opts?: DriverTurnRequest } = {};
	const driver1 = fakeDriver(seen1, "conv-1");
	const driver2 = fakeDriver(seen2);
	const store = new SessionStore(tmpStorePath());
	const rt = new ToolRoundTrips(driver1);
	await parkAndFail(rt, "call-1", "AskClaude", "expired");
	const streamSimple = makeStreamSimple(driver1, rt, store);
	await collect(
		streamSimple(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{ role: "user", content: "do the task", timestamp: Date.now() },
				],
			}),
			options,
		),
	);
	// Retry-shaped tail plus a deliverable tombstone: late delivery, no resume.
	const errors = await collect(
		makeStreamSimple(driver2, rt, store)(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					assistantMessage("let me call the tool"),
					toolResultMessage("call-x", "TOOL OUTPUT"),
					toolResultMessage("call-1", "LATE OUTPUT"),
				],
			}),
			options,
		),
	);
	assert.equal(errors.length, 0);
	assert.ok(seen2.opts);
	assert.match(seen2.opts.prompt, /Late tool delivery/);
	assert.match(seen2.opts.prompt, /LATE OUTPUT/);
	assert.equal(
		seen2.opts.prompt.includes("previous attempt of this turn failed"),
		false,
	);
});

test("resume: digest is skipped on the resume turn", async () => {
	// An other-provider assistant message sits between the watermark and the
	// tail, so a digest built here would be non-empty; without !resume in the
	// gate this prompt would carry DIGEST_PREAMBLE.
	const otherProviderNote = assistantMessage(
		"compaction summary from pi",
		"other",
	);
	const { seen, errors } = await bindThenRetry(
		undefined,
		[
			{
				role: "user",
				content: "do the task",
				timestamp: Date.now(),
			} as Message,
			otherProviderNote,
			assistantMessage("let me call the tool"),
			toolResultMessage("call-x", "TOOL OUTPUT"),
		],
		(env) => {
			env.AGY_DIGEST = "1";
		},
	);
	assert.equal(errors.length, 0);
	assert.ok(seen.opts);
	assert.equal(seen.opts.prompt.includes(DIGEST_PREAMBLE), false);
	assert.equal(seen.opts.contextBlock, undefined);
});

test("digest control: the same transcript with a user tail does carry the digest", async () => {
	const { seen, errors } = await bindThenRetry(
		undefined,
		[
			{
				role: "user",
				content: "do the task",
				timestamp: Date.now(),
			} as Message,
			assistantMessage("compaction summary from pi", "other"),
			{ role: "user", content: "follow-up", timestamp: Date.now() } as Message,
		],
		(env) => {
			env.AGY_DIGEST = "1";
		},
	);
	assert.equal(errors.length, 0);
	assert.ok(seen.opts);
	assert.equal(seen.opts.prompt.includes(DIGEST_PREAMBLE), true);
});

/** Driver whose first turn emits one bridge_call (parks the provider) and
 *  never settles an outcome. snapshot() reports the live conversation, the
 *  way a parked stream-json/ACP turn does. */
function parkingDriver(
	seen: { opts?: DriverTurnRequest },
	conversationId?: string,
) {
	const activities: DriverActivity[] = [
		{ type: "bridge_call", callId: "call-1", name: "AskClaude", args: {} },
	];
	const fakeHandle = {
		id: "park-turn",
		outcome: new Promise<never>(() => {}),
		next: async (): Promise<DriverActivity | null> =>
			activities.shift() ?? null,
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
		snapshot: () => ({ state: "busy", conversationId, stats: {} }),
	} as unknown as StreamDriver;
}

/** Stream-json session key used by every test here (options.sessionId +
 *  stream-json scope). */
const STORE_KEY = "sid:resume-test";

test("resume: a first turn that parks then dies still leaves a binding for the retry", async () => {
	const seen1: { opts?: DriverTurnRequest } = {};
	const store = new SessionStore(tmpStorePath());
	const parking = parkingDriver(seen1, "conv-park");
	const stream1 = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: parking,
		roundTrips: new ToolRoundTrips(parking),
	});
	const pass1Errors = await collect(
		stream1(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{ role: "user", content: "do the task", timestamp: Date.now() },
				],
			}),
			options,
		),
	);
	assert.equal(pass1Errors.length, 0);
	assert.equal(store.get(STORE_KEY)?.conversationId, "conv-park");

	// Simulate the process restart: in-memory round-trips and tombstones die,
	// only the store survives. The retry-dropped tail then has a conversation
	// to resume into.
	const seen2: { opts?: DriverTurnRequest } = {};
	const rt2 = new ToolRoundTrips(fakeDriver(seen2));
	const stream2 = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: fakeDriver(seen2, "conv-park"),
		roundTrips: rt2,
	});
	const errors = await collect(
		stream2(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{
						role: "user",
						content: "do the task",
						timestamp: Date.now(),
					} as Message,
					assistantMessage("let me call the tool"),
					toolResultMessage("call-1", "TOOL OUTPUT"),
				],
			}),
			options,
		),
	);
	assert.equal(errors.length, 0);
	assert.ok(seen2.opts);
	assert.equal(seen2.opts.conversationId, "conv-park");
	assert.match(
		seen2.opts.prompt,
		/previous attempt of this turn failed and was discarded/,
	);
});

test("resume: park without a snapshot conversation id leaves no binding, hard error stays", async () => {
	const seen1: { opts?: DriverTurnRequest } = {};
	const store = new SessionStore(tmpStorePath());
	const parking = parkingDriver(seen1, undefined);
	const stream1 = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: parking,
		roundTrips: new ToolRoundTrips(parking),
	});
	await collect(
		stream1(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{ role: "user", content: "do the task", timestamp: Date.now() },
				],
			}),
			options,
		),
	);
	assert.equal(store.get(STORE_KEY), null);

	const seen2: { opts?: DriverTurnRequest } = {};
	const stream2 = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: fakeDriver(seen2),
		roundTrips: new ToolRoundTrips(fakeDriver(seen2)),
	});
	const errors = await collect(
		stream2(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{
						role: "user",
						content: "do the task",
						timestamp: Date.now(),
					} as Message,
					assistantMessage("let me call the tool"),
					toolResultMessage("call-1", "TOOL OUTPUT"),
				],
			}),
			options,
		),
	);
	assert.equal(seen2.opts, undefined);
	assert.equal(errors.length, 1);
	assert.equal(errors[0].errorMessage, "No user message to send to agy.");
});

test("resume: a park does not overwrite an existing binding", async () => {
	const seenBind: { opts?: DriverTurnRequest } = {};
	const store = new SessionStore(tmpStorePath());
	const rt = new ToolRoundTrips(fakeDriver(seenBind));
	const streamBind = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: fakeDriver(seenBind, "conv-A"),
		roundTrips: rt,
	});
	await collect(
		streamBind(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{ role: "user", content: "do the task", timestamp: Date.now() },
				],
			}),
			options,
		),
	);
	assert.equal(store.get(STORE_KEY)?.conversationId, "conv-A");

	// Next turn parks on a DIFFERENT conversation: the record must not move.
	const parking = parkingDriver({}, "conv-park");
	const streamPark = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: parking,
		roundTrips: new ToolRoundTrips(parking),
	});
	await collect(
		streamPark(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{ role: "user", content: "follow-up", timestamp: Date.now() },
				],
			}),
			options,
		),
	);
	assert.equal(store.get(STORE_KEY)?.conversationId, "conv-A");
});

test("resume: an ERROR outcome after the park keeps the park-time binding", async () => {
	const seen1: { opts?: DriverTurnRequest } = {};
	const store = new SessionStore(tmpStorePath());
	const parking = parkingDriver(seen1, "conv-park");
	const stream1 = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: parking,
		roundTrips: new ToolRoundTrips(parking),
	});
	await collect(
		stream1(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{ role: "user", content: "do the task", timestamp: Date.now() },
				],
			}),
			options,
		),
	);
	assert.equal(store.get(STORE_KEY)?.conversationId, "conv-park");

	// Retry pass fails outright; the binding from the park must survive.
	const errorHandle = {
		id: "err-turn",
		outcome: Promise.resolve({
			status: "ERROR" as const,
			error: "agy died",
			finished: true,
			aborted: false,
			conversationId: "conv-park",
		}),
		next: async (): Promise<DriverActivity | null> => null,
		pushExternal: (_a: DriverActivity) => {},
	};
	const errorDriver = {
		get activeHandle() {
			return errorHandle;
		},
		kickIdle: () => {},
		reentry: () => null,
		run: async () => errorHandle,
		snapshot: () => ({ state: "busy", conversationId: "conv-park", stats: {} }),
	} as unknown as StreamDriver;
	const seen2: { opts?: DriverTurnRequest } = {};
	const stream2 = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: errorDriver,
		roundTrips: new ToolRoundTrips(fakeDriver(seen2)),
	});
	const retryErrors = await collect(
		stream2(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{
						role: "user",
						content: "do the task",
						timestamp: Date.now(),
					} as Message,
					assistantMessage("let me call the tool"),
					toolResultMessage("call-1", "TOOL OUTPUT"),
				],
			}),
			options,
		),
	);
	assert.equal(retryErrors.length, 1);
	assert.equal(store.get(STORE_KEY)?.conversationId, "conv-park");

	// A later retry still has the conversation to resume into.
	const seen3: { opts?: DriverTurnRequest } = {};
	const stream3 = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: fakeDriver(seen3, "conv-park"),
		roundTrips: new ToolRoundTrips(fakeDriver(seen3)),
	});
	const errors = await collect(
		stream3(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{
						role: "user",
						content: "do the task",
						timestamp: Date.now(),
					} as Message,
					assistantMessage("let me call the tool"),
					toolResultMessage("call-1", "TOOL OUTPUT"),
				],
			}),
			options,
		),
	);
	assert.equal(errors.length, 0);
	assert.ok(seen3.opts);
	assert.equal(seen3.opts.conversationId, "conv-park");
	assert.match(
		seen3.opts.prompt,
		/previous attempt of this turn failed and was discarded/,
	);
});

test("resume: a deadline kill of a turn that parked keeps the binding and the retryable timeout error", async () => {
	const seen1: { opts?: DriverTurnRequest } = {};
	const store = new SessionStore(tmpStorePath());
	const parking = parkingDriver(seen1, "conv-park");
	const stream1 = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: parking,
		roundTrips: new ToolRoundTrips(parking),
	});
	await collect(
		stream1(
			model,
			normalizeContext({
				systemPrompt: undefined,
				messages: [
					{ role: "user", content: "do the task", timestamp: Date.now() },
				],
			}),
			options,
		),
	);
	assert.equal(store.get(STORE_KEY)?.conversationId, "conv-park");

	// The parked turn then hits the overall cap. modelOutputSeen proves the
	// turn worked, so this must NOT take the poisoned-resume branch (which
	// would delete the binding and replace the retryable timeout message with
	// "conversation is dead").
	const deadlineHandle = {
		id: "deadline-turn",
		outcome: Promise.resolve({
			status: "ERROR" as const,
			error: "agy exceeded the 15m turn timeout",
			finished: true,
			aborted: false,
			conversationId: "conv-park",
			deadline: "timeout" as const,
			sawResult: false,
			modelOutputSeen: true,
		}),
		next: async (): Promise<DriverActivity | null> => null,
		pushExternal: (_a: DriverActivity) => {},
	};
	const deadlineDriver = {
		get activeHandle() {
			return deadlineHandle;
		},
		kickIdle: () => {},
		reentry: () => null,
		run: async () => deadlineHandle,
		snapshot: () => ({ state: "busy", conversationId: "conv-park", stats: {} }),
	} as unknown as StreamDriver;
	const seen2: { opts?: DriverTurnRequest } = {};
	const stream2 = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: deadlineDriver,
		roundTrips: new ToolRoundTrips(fakeDriver(seen2)),
	});
	const retryMessages: Message[] = [
		{ role: "user", content: "do the task", timestamp: Date.now() } as Message,
		assistantMessage("let me call the tool"),
		toolResultMessage("call-1", "TOOL OUTPUT"),
	];
	const retryErrors = await collect(
		stream2(
			model,
			normalizeContext({ systemPrompt: undefined, messages: retryMessages }),
			options,
		),
	);
	assert.equal(retryErrors.length, 1);
	assert.match(retryErrors[0].errorMessage ?? "", /turn timeout/);
	assert.equal(store.get(STORE_KEY)?.conversationId, "conv-park");

	// The next retry resumes into conv-park instead of hard-erroring.
	const seen3: { opts?: DriverTurnRequest } = {};
	const stream3 = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver: fakeDriver(seen3, "conv-park"),
		roundTrips: new ToolRoundTrips(fakeDriver(seen3)),
	});
	const errors = await collect(
		stream3(
			model,
			normalizeContext({ systemPrompt: undefined, messages: retryMessages }),
			options,
		),
	);
	assert.equal(errors.length, 0);
	assert.ok(seen3.opts);
	assert.equal(seen3.opts.conversationId, "conv-park");
	assert.match(
		seen3.opts.prompt,
		/previous attempt of this turn failed and was discarded/,
	);
});

test("resume: an image-only user tail does not resume (images ride normally)", async () => {
	const { seen, errors } = await bindThenRetry(undefined, [
		{
			role: "user",
			content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			timestamp: Date.now(),
		} as unknown as Message,
	]);
	assert.equal(errors.length, 0);
	assert.ok(seen.opts);
	assert.equal(
		seen.opts.prompt.includes("previous attempt of this turn failed"),
		false,
	);
	assert.equal(seen.opts.images?.length, 1);
});
