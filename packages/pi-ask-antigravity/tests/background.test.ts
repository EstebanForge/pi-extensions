import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import factory from "../extensions/index.js";

const ENV_AGY_BIN = "AGY_BIN";
const ENV_HOME = "HOME";
const FIXTURE = join(import.meta.dirname, "fixtures/fake-agy.mjs");

let saved: Record<string, string | undefined>;
let fakeBin: string;

const writeFake = (delayMs: number) => {
	writeFileSync(
		fakeBin,
		`#!/usr/bin/env node\nprocess.env.FAKE_DELAY_MS = ${JSON.stringify(String(delayMs))};\nawait import(${JSON.stringify(FIXTURE)});\n`,
		{ mode: 0o755 },
	);
};

const makePi = () => {
	const state = {
		tools: [] as any[],
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
			getFlag: () => undefined,
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		},
		{
			get(target, prop) {
				return prop in target ? (target as any)[prop] : () => {};
			},
		},
	);
	return { pi, state };
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
		[ENV_AGY_BIN]: process.env[ENV_AGY_BIN],
		[ENV_HOME]: process.env[ENV_HOME],
	};
	// Empty HOME: the bridge stand-down scans ~/.pi paths for the bridge
	// package; on this machine it IS installed, so the factory would defer.
	// Same trick as empty-output.test.ts.
	process.env[ENV_HOME] = mkdtempSync(join(tmpdir(), "askbg-agy-home-"));
	fakeBin = join(mkdtempSync(join(tmpdir(), "askbg-agy-")), "fake-agy.mjs");
	process.env[ENV_AGY_BIN] = fakeBin;
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("AskAntigravity background mode", () => {
	it("returns a runId at once and delivers the answer as a wake message (no handle when agy creates none)", async () => {
		writeFake(150);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskAntigravity");
		expect(tool).toBeDefined();

		const result = await tool.execute("t1", { prompt: "review src/foo.ts", background: true }, undefined, undefined, runCtx());
		expect(result.content[0].text).toMatch(/Background run bg_[0-9a-f]+ started/);
		expect(result.content[0].text).toMatch(/Do not poll/);

		await waitFor(() => state.sendMessage.mock.calls.length > 0, "wake message");
		const [msg, opts] = state.sendMessage.mock.calls[0];
		expect(msg.customType).toBe("ask-antigravity-result");
		expect(msg.display).toBe(true);
		expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(msg.content).toContain("finished");
		expect(msg.content).toContain("UNTRUSTED");
		expect(msg.content).toContain("FAKE AGY OUTPUT");
		// The fake creates no agy conversation, so discovery finds nothing:
		// the wake must say so instead of inventing a handle.
		expect(msg.content).toMatch(/[Nn]o resume handle/);
	});

	it("still returns the answer inline in blocking mode and never wakes", async () => {
		writeFake(0);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskAntigravity");

		const result = await tool.execute("t2", { prompt: "one-shot" }, undefined, undefined, runCtx());
		expect(result.content[0].text).toContain("FAKE AGY OUTPUT");
		await new Promise((r) => setTimeout(r, 150));
		expect(state.sendMessage).not.toHaveBeenCalled();
	});

	it("/agy-stop kills the run, settles it failed, and wakes with the failure", async () => {
		writeFake(30000);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskAntigravity");
		const stop = state.commands.get("agy-stop");
		expect(stop).toBeDefined();

		const result = await tool.execute("t3", { prompt: "long run", background: true }, undefined, undefined, runCtx());
		const runId = result.content[0].text.match(/bg_[0-9a-f]+/)?.[0];
		expect(runId).toBeDefined();

		const notify = vi.fn();
		const stopCtx = runCtx({ ui: { notify } });
		await stop!("", stopCtx);
		await waitFor(() => state.sendMessage.mock.calls.length > 0, "failure wake");
		const [msg] = state.sendMessage.mock.calls[0];
		expect(msg.content).toContain("FAILED");
		expect(msg.content).toContain("stopped via /agy-stop");
		expect(msg.content).toContain(runId!);

		notify.mockClear();
		await stop!("", stopCtx);
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/No running/), "info");
		expect(state.sendMessage.mock.calls.length).toBe(1); // no duplicate wake
	});

	it("refuses a second background run resuming the same conversationId (per-handle lock)", async () => {
		writeFake(30000);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskAntigravity");
		const convId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

		const first = await tool.execute(
			"t4a",
			{ prompt: "first", background: true, conversationId: convId },
			undefined,
			undefined,
			runCtx(),
		);
		expect(first.content[0].text).toMatch(/Background run bg_[0-9a-f]+ started/);

		const second = await tool.execute(
			"t4b",
			{ prompt: "second", background: true, conversationId: convId },
			undefined,
			undefined,
			runCtx(),
		);
		expect(second.content[0].text).toMatch(/background refused/);
		expect(second.content[0].text).toContain(convId);

		// Cleanup: stop the first run so nothing dangles into the next test.
		const stop = state.commands.get("agy-stop");
		await stop!("", runCtx());
	});

	it("refuses background in print and json modes", async () => {
		writeFake(0);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskAntigravity");

		for (const mode of ["print", "json"]) {
			const result = await tool.execute("t5", { prompt: "x", background: true }, undefined, undefined, runCtx({ mode }));
			expect(result.content[0].text).toMatch(/not available in print\/json mode/);
		}
		await new Promise((r) => setTimeout(r, 100));
		expect(state.sendMessage).not.toHaveBeenCalled();
	});

	it("session_shutdown kills in-flight runs and stays silent (no wake after dispose)", async () => {
		writeFake(30000);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskAntigravity");
		const shutdown = state.handlers.get("session_shutdown");
		expect(shutdown).toBeDefined();

		await tool.execute("t6", { prompt: "long run", background: true }, undefined, undefined, runCtx());
		shutdown!({ type: "session_shutdown", reason: "quit" }, runCtx());

		await new Promise((r) => setTimeout(r, 400));
		expect(state.sendMessage).not.toHaveBeenCalled();
	});
});
