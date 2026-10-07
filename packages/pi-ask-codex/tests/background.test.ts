import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import factory from "../extensions/index.js";

const ENV_CODEX_BIN = "CODEX_BIN";
const FIXTURE = join(import.meta.dirname, "fixtures/fake-codex.mjs");

let savedBin: string | undefined;
let fakeBin: string;

/** Launcher that re-runs the shared fixture with a per-test delay. */
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
	const deadline = Date.now() + 5000;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
};

beforeEach(() => {
	savedBin = process.env[ENV_CODEX_BIN];
	fakeBin = join(mkdtempSync(join(tmpdir(), "askbg-codex-")), "fake-codex.mjs");
	process.env[ENV_CODEX_BIN] = fakeBin;
});

afterEach(() => {
	if (savedBin === undefined) delete process.env[ENV_CODEX_BIN];
	else process.env[ENV_CODEX_BIN] = savedBin;
});

describe("AskCodex background mode", () => {
	it("returns a runId at once and delivers the answer as a wake message with the resume handle", async () => {
		writeFake(150);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskCodex");
		expect(tool).toBeDefined();

		const result = await tool.execute("t1", { prompt: "review src/foo.ts", background: true }, undefined, undefined, runCtx());
		expect(result.content[0].text).toMatch(/Background run bg_[0-9a-f]+ started/);
		expect(result.content[0].text).toMatch(/Do not poll/);

		await waitFor(() => state.sendMessage.mock.calls.length > 0, "wake message");
		const [msg, opts] = state.sendMessage.mock.calls[0];
		expect(msg.customType).toBe("ask-codex-result");
		expect(msg.display).toBe(true);
		expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(msg.content).toContain("finished");
		expect(msg.content).toContain("UNTRUSTED");
		expect(msg.content).toContain("sessionId=99999999-8888-7777-6666-555555555555");
		expect(msg.content).toContain("FAKE CODEX ANSWER");
	});

	it("still returns the answer inline in blocking mode and never wakes", async () => {
		writeFake(0);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskCodex");

		const result = await tool.execute("t2", { prompt: "one-shot" }, undefined, undefined, runCtx());
		expect(result.content[0].text).toContain("FAKE CODEX ANSWER");
		expect(result.content[0].text).toMatch(/\[codex sessionId: 99999999-/);
		await new Promise((r) => setTimeout(r, 150));
		expect(state.sendMessage).not.toHaveBeenCalled();
	});

	it("/codex-stop kills the run, settles it failed, and wakes with the failure", async () => {
		writeFake(30000);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskCodex");
		const stop = state.commands.get("codex-stop");
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
		expect(msg.content).toContain("stopped via /codex-stop");
		expect(msg.content).toContain(runId!);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Stopped "), "info");

		notify.mockClear();
		await stop!("", stopCtx);
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/No running/), "info");
		expect(state.sendMessage.mock.calls.length).toBe(1); // no duplicate wake
	});

	it("refuses background in print and json modes", async () => {
		writeFake(0);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskCodex");

		for (const mode of ["print", "json"]) {
			const result = await tool.execute("t4", { prompt: "x", background: true }, undefined, undefined, runCtx({ mode }));
			expect(result.content[0].text).toMatch(/not available in print\/json mode/);
		}
		await new Promise((r) => setTimeout(r, 100));
		expect(state.sendMessage).not.toHaveBeenCalled();
	});

	it("session_shutdown kills in-flight runs and stays silent (no wake after dispose)", async () => {
		writeFake(30000);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskCodex");
		const shutdown = state.handlers.get("session_shutdown");
		expect(shutdown).toBeDefined();

		await tool.execute("t5", { prompt: "long run", background: true }, undefined, undefined, runCtx());
		shutdown!({ type: "session_shutdown", reason: "quit" }, runCtx());

		await new Promise((r) => setTimeout(r, 400));
		expect(state.sendMessage).not.toHaveBeenCalled();
	});
});
