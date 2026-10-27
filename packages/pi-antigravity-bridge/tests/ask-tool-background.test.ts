// Background-mode tests for the bridge's AskAntigravity tool, mirroring the
// standalone pi-ask-antigravity suite: a background call returns a runId at
// once, the answer arrives as a wake message, /agy-stop kills, and
// session_shutdown disposes silently. Bridge-specific: the MCP-suppression
// window must span the whole detached run and release exactly once.
// Run: npm test

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { toolModelsFromRaw } from "../src/ask-tool.js";

const sup = vi.hoisted(() => {
	const releases: Array<ReturnType<typeof vi.fn>> = [];
	return {
		acquireBridgeSuppression: vi.fn(() => {
			const release = vi.fn();
			releases.push(release);
			return release;
		}),
		releases,
	};
});

vi.mock("../src/mcp-registration.js", () => ({
	acquireBridgeSuppression: sup.acquireBridgeSuppression,
}));

const FIXTURE = join(import.meta.dirname, "fixtures/fake-agy-ask.mjs");

let saved: Record<string, string | undefined>;
let fakeBin: string;
let scratch: string;

const writeFake = (delayMs: number) => {
	writeFileSync(
		fakeBin,
		`#!/usr/bin/env node\nprocess.env.FAKE_DELAY_MS = ${JSON.stringify(String(delayMs))};\nawait import(${JSON.stringify(FIXTURE)});\n`,
		{ mode: 0o755 },
	);
};

const makePi = () => {
	const state = {
		tools: [] as Array<{ name: string; execute: Function; [k: string]: unknown }>,
		commands: new Map<string, (args: string, ctx: any) => Promise<void>>(),
		handlers: new Map<string, (event: any, ctx: any) => unknown>(),
		sendMessage: vi.fn(),
	};
	const pi: any = new Proxy(
		{
			registerTool: (def: any) => state.tools.push(def),
			registerCommand: (name: string, opts: any) => state.commands.set(name, opts.handler),
			on: (event: string, handler: any) => state.handlers.set(event, handler),
			sendMessage: (msg: any, opts: any) => state.sendMessage(msg, opts),
		},
		{
			get(target, prop) {
				return prop in target ? (target as any)[prop] : () => {};
			},
		},
	);
	return { pi, state };
};

const register = async () => {
	// Fresh module graph per registration: shared's module-level env reads
	// (CONVERSATIONS_DIR among them) must see the beforeEach scratch env,
	// not whatever was real at file-load time.
	vi.resetModules();
	const { registerAskAntigravityTool } = await import("../src/ask-tool.js");
	const { pi, state } = makePi();
	await registerAskAntigravityTool(pi, toolModelsFromRaw(""));
	const tool = state.tools.find((t) => t.name === "AskAntigravity");
	assert.ok(tool, "AskAntigravity tool must register");
	return { state, tool: tool! };
};

const runCtx = (over: Record<string, unknown> = {}) => ({
	cwd: tmpdir(),
	mode: "tui",
	hasUI: true,
	ui: { notify: vi.fn() },
	model: undefined,
	sessionManager: { getBranch: () => [] },
	...over,
});

const waitFor = async (pred: () => boolean, what: string) => {
	const deadline = Date.now() + 8000;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
};

beforeEach(() => {
	saved = {
		HOME: process.env.HOME,
		AGY_BIN: process.env.AGY_BIN,
		AGY_AGENTS_ROOT: process.env.AGY_AGENTS_ROOT,
		AGY_CONVERSATIONS_DIR: process.env.AGY_CONVERSATIONS_DIR,
		AGY_MODE: process.env.AGY_MODE,
		AGY_READONLY: process.env.AGY_READONLY,
	};
	// Empty HOME: config resolution reads os.homedir()/.pi/agent/...; on this
	// machine a real config could flip mode/readOnly under the tests.
	scratch = mkdtempSync(join(tmpdir(), "askbg-bridge-"));
	process.env.HOME = mkdtempSync(join(tmpdir(), "askbg-bridge-home-"));
	process.env.AGY_AGENTS_ROOT = join(scratch, "agents");
	process.env.AGY_CONVERSATIONS_DIR = join(scratch, "conversations");
	process.env.AGY_MODE = "accept-edits";
	delete process.env.AGY_READONLY;
	fakeBin = join(scratch, "fake-agy.mjs");
	process.env.AGY_BIN = fakeBin;
});

afterEach(async () => {
	// Fresh spy state per test; each test ends its own runs (stop/shutdown).
	for (const release of sup.releases) release.mockClear();
	sup.acquireBridgeSuppression.mockClear();
	sup.releases.length = 0;
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

test("background: runId at once, answer arrives as a wake message with no invented handle", async () => {
	writeFake(150);
	const { state, tool } = await register();

	const result = await tool.execute(
		"t1",
		{ prompt: "review src/foo.ts", background: true },
		undefined,
		undefined,
		runCtx(),
	);
	assert.match(result.content[0].text, /Background run bg_[0-9a-f]+ started/);
	assert.match(result.content[0].text, /Do not poll/);

	await waitFor(() => state.sendMessage.mock.calls.length > 0, "wake message");
	const [msg, opts] = state.sendMessage.mock.calls[0];
	assert.equal(msg.customType, "ask-antigravity-result");
	assert.equal(msg.display, true);
	assert.deepEqual(opts, { triggerTurn: true, deliverAs: "followUp" });
	assert.match(msg.content, /finished/);
	assert.match(msg.content, /UNTRUSTED/);
	assert.match(msg.content, /FAKE AGY OUTPUT/);
	// The fake creates no agy conversation, so discovery finds nothing: the
	// wake must say so instead of inventing a handle.
	assert.match(msg.content, /[Nn]o resume handle/);
});

test("blocking: answer stays inline and never wakes", async () => {
	writeFake(0);
	const { state, tool } = await register();

	const result = await tool.execute("t2", { prompt: "one-shot" }, undefined, undefined, runCtx());
	assert.match(result.content[0].text, /FAKE AGY OUTPUT/);
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(state.sendMessage.mock.calls.length, 0);
});

test("/agy-stop kills the run, settles it failed, and wakes once", async () => {
	writeFake(30000);
	const { state, tool } = await register();
	const stop = state.commands.get("agy-stop");
	assert.ok(stop, "/agy-stop must register");

	const result = await tool.execute(
		"t3",
		{ prompt: "long run", background: true },
		undefined,
		undefined,
		runCtx(),
	);
	const runId = result.content[0].text.match(/bg_[0-9a-f]+/)?.[0];
	assert.ok(runId);

	const notify = vi.fn();
	const stopCtx = runCtx({ ui: { notify } });
	await stop("", stopCtx);
	await waitFor(() => state.sendMessage.mock.calls.length > 0, "failure wake");
	const [msg] = state.sendMessage.mock.calls[0];
	assert.match(msg.content, /FAILED/);
	assert.match(msg.content, /stopped via \/agy-stop/);
	assert.match(msg.content, new RegExp(runId!));

	notify.mockClear();
	await stop("", stopCtx);
	assert.match(notify.mock.calls[0][0], /No running/);
	// Wait past the natural close classification: a broken settle latch
	// would emit its duplicate wake here.
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(state.sendMessage.mock.calls.length, 1); // no duplicate wake
});

test("per-conversation lock: a second background run on the same conversationId is refused", async () => {
	writeFake(30000);
	const { state, tool } = await register();
	const convId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

	const first = await tool.execute(
		"t4a",
		{ prompt: "first", background: true, conversationId: convId },
		undefined,
		undefined,
		runCtx(),
	);
	assert.match(first.content[0].text, /Background run bg_[0-9a-f]+ started/);

	const second = await tool.execute(
		"t4b",
		{ prompt: "second", background: true, conversationId: convId },
		undefined,
		undefined,
		runCtx(),
	);
	assert.match(second.content[0].text, /background refused/);
	assert.match(second.content[0].text, new RegExp(convId));

	const stop = state.commands.get("agy-stop");
	assert.ok(stop);
	await stop("", runCtx());
});

test("per-conversation lock: a blocking resume is refused while a background run holds the conversation", async () => {
	writeFake(30000);
	const { state, tool } = await register();
	const convId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

	const first = await tool.execute(
		"t5a",
		{ prompt: "bg run", background: true, conversationId: convId },
		undefined,
		undefined,
		runCtx(),
	);
	assert.match(first.content[0].text, /Background run bg_[0-9a-f]+ started/);

	const second = await tool.execute(
		"t5b",
		{ prompt: "blocking resume", conversationId: convId },
		undefined,
		undefined,
		runCtx(),
	);
	const stop = state.commands.get("agy-stop");
	assert.ok(stop);
	await stop("", runCtx());
	await waitFor(() => (sup.releases[0]?.mock.calls.length ?? 0) > 0, "suppression release");
	assert.match(second.content[0].text, /already has a run in flight/);
	assert.match(second.content[0].text, /if it is a background run, \/agy-stop can stop it/);
});

test("background is refused in print and json modes (process exits before the wake)", async () => {
	writeFake(0);
	const { state, tool } = await register();

	for (const mode of ["print", "json"]) {
		const result = await tool.execute("t6", { prompt: "x", background: true }, undefined, undefined, runCtx({ mode }));
		assert.match(result.content[0].text, /not available in print\/json mode/);
	}
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(state.sendMessage.mock.calls.length, 0);
	assert.equal(sup.acquireBridgeSuppression.mock.calls.length, 0); // refusal fires before any spawn
});

test("session_shutdown kills in-flight runs and stays silent", async () => {
	writeFake(30000);
	const { state, tool } = await register();
	const shutdown = state.handlers.get("session_shutdown");
	assert.ok(shutdown, "session_shutdown handler must register");

	await tool.execute("t7", { prompt: "long run", background: true }, undefined, undefined, runCtx());
	shutdown({ type: "session_shutdown", reason: "quit" }, runCtx());

	// The kill must run the full close path: suppression released, and still
	// silent after the point where a natural settle would have classified.
	await waitFor(() => sup.releases.length > 0 && sup.releases[0].mock.calls.length > 0, "suppression release");
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(state.sendMessage.mock.calls.length, 0);
	assert.equal(sup.releases[0].mock.calls.length, 1);
});

test("suppression window spans the detached run and releases exactly once", async () => {
	writeFake(30000);
	const { state, tool } = await register();

	const result = await tool.execute(
		"t8",
		{ prompt: "long run", background: true },
		undefined,
		undefined,
		runCtx(),
	);
	assert.match(result.content[0].text, /Background run bg_[0-9a-f]+ started/);
	// execute() returned but agy is still alive: the window must hold.
	assert.equal(sup.acquireBridgeSuppression.mock.calls.length, 1);
	assert.equal(sup.releases.length, 1);
	assert.equal(sup.releases[0].mock.calls.length, 0);

	const stop = state.commands.get("agy-stop");
	assert.ok(stop);
	await stop("", runCtx());
	await waitFor(() => sup.releases[0].mock.calls.length > 0, "suppression release");
	// Wait past the finally backstop: the double-release this guards against
	// fired a tick after the first release before the released-flag fix.
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(sup.releases[0].mock.calls.length, 1);
});

test("suppression releases exactly once when a background run settles on its own", async () => {
	writeFake(100);
	const { tool } = await register();

	await tool.execute("t9", { prompt: "short run", background: true }, undefined, undefined, runCtx());
	await waitFor(() => sup.releases.length > 0 && sup.releases[0].mock.calls.length > 0, "suppression release");
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(sup.acquireBridgeSuppression.mock.calls.length, 1);
	assert.equal(sup.releases[0].mock.calls.length, 1);
});

test("registry cap: the fifth concurrent background run is refused and leaks nothing", async () => {
	writeFake(30000);
	const { state, tool } = await register();
	const shutdown = state.handlers.get("session_shutdown");
	assert.ok(shutdown);

	for (let i = 0; i < 4; i++) {
		const r = await tool.execute(`cap-${i}`, { prompt: "long run", background: true }, undefined, undefined, runCtx());
		assert.match(r.content[0].text, /Background run bg_[0-9a-f]+ started/);
	}
	const fifth = await tool.execute("cap-4", { prompt: "one too many", background: true }, undefined, undefined, runCtx());
	assert.match(fifth.content[0].text, /background refused/);
	assert.equal(state.sendMessage.mock.calls.length, 0);
	assert.equal(sup.acquireBridgeSuppression.mock.calls.length, 4); // refusal fired before any spawn

	shutdown({ type: "session_shutdown", reason: "quit" }, runCtx());
	await waitFor(() => sup.releases.length === 4 && sup.releases.every((r) => r.mock.calls.length > 0), "all four releases");
});

test("spawn failure wakes as failed and releases suppression once", async () => {
	writeFake(0);
	const { state, tool } = await register();
	process.env.AGY_BIN = join(scratch, "missing-agy-binary");

	const result = await tool.execute("t10", { prompt: "boom", background: true }, undefined, undefined, runCtx());
	assert.match(result.content[0].text, /Background run bg_[0-9a-f]+ started/);

	await waitFor(() => state.sendMessage.mock.calls.length > 0, "failure wake");
	const [msg] = state.sendMessage.mock.calls[0];
	assert.match(msg.content, /FAILED/);
	assert.match(msg.content, /failed to run agy/);
	await waitFor(() => sup.releases.length > 0 && sup.releases[0].mock.calls.length > 0, "suppression release");
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(sup.releases[0].mock.calls.length, 1);
});

test("/agy-stop during the finishing window refuses instead of discarding the answer", async () => {
	writeFake(150);
	const { state, tool } = await register();
	const stop = state.commands.get("agy-stop");
	assert.ok(stop);

	const result = await tool.execute(
		"t11",
		{ prompt: "answer on the way", background: true },
		undefined,
		undefined,
		runCtx(),
	);
	assert.match(result.content[0].text, /Background run bg_[0-9a-f]+ started/);

	// The suppression release fires at close, so this wait ends inside the
	// finishing window, well before discovery's ~500ms sweep settles the run.
	await waitFor(() => sup.releases.length > 0 && sup.releases[0].mock.calls.length > 0, "close");
	const notify = vi.fn();
	await stop("", runCtx({ ui: { notify } }));
	assert.match(notify.mock.calls[0][0], /already finished/);
	assert.match(notify.mock.calls[0][0], /being delivered/);

	await waitFor(() => state.sendMessage.mock.calls.length > 0, "wake");
	const [msg] = state.sendMessage.mock.calls[0];
	assert.match(msg.content, /finished/);
	assert.match(msg.content, /FAKE AGY OUTPUT/);
	assert.match(msg.content, /[Nn]o resume handle/);
	assert.doesNotMatch(msg.content, /FAILED/);
	assert.equal(state.sendMessage.mock.calls.length, 1);
});
