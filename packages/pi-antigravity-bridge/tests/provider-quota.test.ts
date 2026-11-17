// Issue #16: agy streams the account quota notice as agent text and ends the
// turn OK, so a text-only notice turn must settle as a RETRYABLE pi error
// (the provider-failover signal) instead of a successful reply. Turns that
// ran tools or produced thinking keep the normal reply. The session binding
// is untouched: the conversation itself is healthy, unlike the issue #2
// silent-drop signature.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { AssistantMessage, Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { ToolRoundTrips, createStreamSimple } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { StreamDriver, DriverTurnRequest, TurnOutcome } from "../src/driver.js";
import type { DriverActivity, TurnHandle } from "../src/driver-types.js";

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
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	});
}

const NOTICE = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 153h38m14s";

const QUOTA_OUTCOME: TurnOutcome = {
	status: "OK",
	response: NOTICE,
	finished: true,
	aborted: false,
	conversationId: "conv-q",
	modelOutputSeen: true,
	sawResult: true,
};

const OK_CONV = (conversationId: string): TurnOutcome => ({
	status: "OK",
	response: "ok",
	finished: true,
	aborted: false,
	conversationId,
	modelOutputSeen: true,
	sawResult: true,
});

interface TurnScript {
	outcome: TurnOutcome;
	activities?: DriverActivity[];
}

interface Harness {
	seen: { opts?: DriverTurnRequest };
	streamSimple: ReturnType<typeof createStreamSimple>;
	dir: string;
}

function harness(scripted: TurnScript[]): Harness {
	let call = 0;
	const seen: { opts?: DriverTurnRequest } = {};
	const driver: StreamDriver = {
		run: async (opts: DriverTurnRequest) => {
			seen.opts = opts;
			const script = scripted[Math.min(call, scripted.length - 1)];
			call += 1;
			const activities = [...(script.activities ?? [])];
			return {
				id: "fake-turn",
				outcome: Promise.resolve(script.outcome),
				next: async () => activities.shift() ?? null,
				pushExternal: () => {},
			} satisfies TurnHandle as unknown as TurnHandle;
		},
	} as unknown as StreamDriver;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-"));
	const store = new SessionStore(path.join(dir, "sessions.json"));
	const streamSimple = createStreamSimple({
		entries: [{ id: "gemini-flash", full: "gemini-3.6-flash" }],
		store,
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	return { seen, streamSimple, dir };
}

interface Terminal {
	type: string;
	reason?: string;
	message?: string;
}

async function runTurn(h: Harness, prompt: string): Promise<Terminal> {
	const stream = h.streamSimple(model, contextWith(prompt), { cwd: h.dir } as unknown as SimpleStreamOptions);
	let last: Terminal = { type: "none" };
	for await (const ev of stream) {
		if (ev.type === "done" || ev.type === "error") {
			const evt = ev as { reason?: string; message?: { errorMessage?: string }; error?: { errorMessage?: string } };
			last = { type: ev.type, reason: evt.reason, message: (evt.error ?? evt.message)?.errorMessage };
		}
	}
	return last;
}

function assertRetryable(terminal: Terminal): void {
	assert.equal(terminal.type, "error");
	const message = { stopReason: "error", errorMessage: terminal.message } as AssistantMessage;
	assert.equal(isRetryableAssistantError(message), true);
}

test("quota notice settles as a retryable error with the reset interval", async () => {
	const h = harness([{ outcome: QUOTA_OUTCOME }]);
	try {
		const t = await runTurn(h, "hello");
		assertRetryable(t);
		assert.match(t.message ?? "", /153h38m14s/);
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("quota notice on a bound conversation keeps the binding", async () => {
	const h = harness([{ outcome: OK_CONV("conv-a") }, { outcome: { ...QUOTA_OUTCOME, conversationId: "conv-a" } }, { outcome: OK_CONV("conv-a") }]);
	try {
		assert.equal((await runTurn(h, "turn one")).type, "done");
		assertRetryable(await runTurn(h, "turn two"));
		// The quota turn must not have touched the binding: turn three resumes.
		await runTurn(h, "turn three");
		assert.equal(h.seen.opts?.conversationId, "conv-a");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("first-turn quota notice never stores a binding", async () => {
	const h = harness([{ outcome: QUOTA_OUTCOME }, { outcome: OK_CONV("conv-next") }]);
	try {
		assertRetryable(await runTurn(h, "first"));
		await runTurn(h, "second");
		assert.equal(h.seen.opts?.conversationId ?? null, null);
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("a normal OK reply still settles as done", async () => {
	const h = harness([{ outcome: OK_CONV("conv-ok") }]);
	try {
		assert.equal((await runTurn(h, "hello")).type, "done");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("notice text after thinking activity is not reclassified", async () => {
	const h = harness([{ outcome: QUOTA_OUTCOME, activities: [{ type: "thought", tokens: 12 }] }]);
	try {
		assert.equal((await runTurn(h, "hello")).type, "done");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("notice text after a tool activity is not reclassified", async () => {
	const h = harness([{ outcome: QUOTA_OUTCOME, activities: [{ type: "tool_start", name: "view_file", args: { file_path: "/tmp/x" } }] }]);
	try {
		assert.equal((await runTurn(h, "hello")).type, "done");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});

test("aborted outcome with notice text is not reclassified", async () => {
	const h = harness([{ outcome: { ...QUOTA_OUTCOME, aborted: true } }]);
	try {
		const t = await runTurn(h, "hello");
		// An abort arrives as an error event with reason "aborted" (finalize).
		assert.equal(t.type, "error");
		assert.equal(t.reason, "aborted");
		assert.equal(t.message, "Operation aborted");
	} finally {
		fs.rmSync(h.dir, { recursive: true, force: true });
	}
});
