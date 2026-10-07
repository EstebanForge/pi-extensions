import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import factory from "../extensions/index.js";

// Same contract as extension.test.ts: PI_CODING_AGENT_DIR points config
// discovery at a throwaway dir; CLAUDE_BIN points the spawn at the fake.
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const ENV_CLAUDE_BIN = "CLAUDE_BIN";

let saved: Record<string, string | undefined>;
let tmpAgentDir: string;
let fakeBin: string;

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
	cwd: tmpAgentDir,
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
	saved = {
		[ENV_AGENT_DIR]: process.env[ENV_AGENT_DIR],
		[ENV_CLAUDE_BIN]: process.env[ENV_CLAUDE_BIN],
	};
	tmpAgentDir = mkdtempSync(join(tmpdir(), "askbg-agent-"));
	process.env[ENV_AGENT_DIR] = tmpAgentDir;
	fakeBin = join(tmpAgentDir, "fake-claude.mjs");
	process.env[ENV_CLAUDE_BIN] = fakeBin;
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("AskClaude background mode", () => {
	it("returns a runId at once and delivers the answer as a wake message with the resume handle", async () => {
		writeFileSync(fakeBin, "#!/usr/bin/env node\n", { mode: 0o755 });
		// Reuse the shared fixture by copying it to the env path.
		writeFileSync(
			fakeBin,
			`#!/usr/bin/env node\nprocess.env.FAKE_DELAY_MS = "150";\nawait import(${JSON.stringify(join(import.meta.dirname, "fixtures/fake-claude.mjs"))});\n`,
			{ mode: 0o755 },
		);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskClaude");
		expect(tool).toBeDefined();

		const started = Date.now();
		const result = await tool.execute("t1", { prompt: "review src/foo.ts", background: true }, undefined, undefined, runCtx());
		const elapsed = Date.now() - started;

		expect(result.isError ?? false).toBe(false);
		expect(result.content[0].text).toMatch(/Background run bg_[0-9a-f]+ started/);
		expect(result.content[0].text).toMatch(/Do not poll/);
		// Detached return: only the availability probe (+ spawn) before returning.
		expect(elapsed).toBeLessThan(4000);

		await waitFor(() => state.sendMessage.mock.calls.length > 0, "wake message");
		const [msg, opts] = state.sendMessage.mock.calls[0];
		expect(msg.customType).toBe("ask-claude-result");
		expect(msg.display).toBe(true);
		expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(msg.content).toContain("finished");
		expect(msg.content).toContain("UNTRUSTED");
		expect(msg.content).toContain("sessionId=11111111-2222-3333-4444-555555555555");
		expect(msg.content).toContain("FAKE ANSWER");
		expect(msg.content).toContain("11111111-2222-3333-4444-555555555555"); // footer handle survives
	});

	it("still returns the answer inline in blocking mode and never wakes", async () => {
		writeFileSync(
			fakeBin,
			`#!/usr/bin/env node\nawait import(${JSON.stringify(join(import.meta.dirname, "fixtures/fake-claude.mjs"))});\n`,
			{ mode: 0o755 },
		);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskClaude");

		const result = await tool.execute("t2", { prompt: "one-shot" }, undefined, undefined, runCtx());
		expect(result.content[0].text).toContain("FAKE ANSWER");
		expect(result.content[0].text).toMatch(/\[claude sessionId: 11111111-/);
		// Give any stray wake a chance to misfire.
		await new Promise((r) => setTimeout(r, 150));
		expect(state.sendMessage).not.toHaveBeenCalled();
	});

	it("/claude-stop kills the run, settles it failed, and wakes with the failure", async () => {
		writeFileSync(
			fakeBin,
			`#!/usr/bin/env node\nprocess.env.FAKE_DELAY_MS = "30000";\nawait import(${JSON.stringify(join(import.meta.dirname, "fixtures/fake-claude.mjs"))});\n`,
			{ mode: 0o755 },
		);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskClaude");
		const stop = state.commands.get("claude-stop");
		expect(stop).toBeDefined();

		const result = await tool.execute("t3", { prompt: "long run", background: true }, undefined, undefined, runCtx());
		const runId = result.content[0].text.match(/bg_[0-9a-f]+/)?.[0];
		expect(runId).toBeDefined();

		// Stop was called with no args: it stops the only running run.
		const notify = vi.fn();
		const stopCtx = runCtx({ ui: { notify } });
		await stop!("", stopCtx);
		await waitFor(() => state.sendMessage.mock.calls.length > 0, "failure wake");
		const [msg] = state.sendMessage.mock.calls[0];
		expect(msg.content).toContain("FAILED");
		expect(msg.content).toContain("stopped via /claude-stop");
		expect(msg.content).toContain(runId!);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Stopped "), "info");

		// Second stop: nothing running anymore.
		notify.mockClear();
		await stop!("", stopCtx);
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/No running/), "info");
		expect(state.sendMessage.mock.calls.length).toBe(1); // no duplicate wake
	});

	it("refuses background in print and json modes", async () => {
		writeFileSync(
			fakeBin,
			`#!/usr/bin/env node\nawait import(${JSON.stringify(join(import.meta.dirname, "fixtures/fake-claude.mjs"))});\n`,
			{ mode: 0o755 },
		);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskClaude");

		for (const mode of ["print", "json"]) {
			const result = await tool.execute("t4", { prompt: "x", background: true }, undefined, undefined, runCtx({ mode }));
			expect(result.content[0].text).toMatch(/not available in print\/json mode/);
			expect(result.content[0].text).toMatch(/without background/);
		}
		await new Promise((r) => setTimeout(r, 100));
		expect(state.sendMessage).not.toHaveBeenCalled();
	});

	it("session_shutdown kills in-flight runs and stays silent (no wake after dispose)", async () => {
		const pidFile = join(tmpAgentDir, "fake.pid");
		writeFileSync(
			fakeBin,
			`#!/usr/bin/env node\nprocess.env.FAKE_DELAY_MS = "30000";\nprocess.env.FAKE_PIDFILE = ${JSON.stringify(pidFile)};\nawait import(${JSON.stringify(join(import.meta.dirname, "fixtures/fake-claude.mjs"))});\n`,
			{ mode: 0o755 },
		);
		const { pi, state } = makePi();
		await factory(pi);
		const tool = state.tools.find((t) => t.name === "AskClaude");
		const shutdown = state.handlers.get("session_shutdown");
		expect(shutdown).toBeDefined();

		await tool.execute("t5", { prompt: "long run", background: true }, undefined, undefined, runCtx());
		// Wait for the fake to record its pid before tearing down.
		await waitFor(() => {
			try {
				return Number.parseInt(readFileSync(pidFile, "utf8"), 10) > 0;
			} catch {
				return false;
			}
		}, "pid file");
		const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		shutdown!({ type: "session_shutdown", reason: "quit" }, runCtx());

		// The killed child's close event fires soon; no wake may land.
		await new Promise((r) => setTimeout(r, 400));
		expect(state.sendMessage).not.toHaveBeenCalled();
		// Kill assertion: the child process must actually be dead, not just forgotten.
		const deadline = Date.now() + 8000;
		let alive = true;
		while (Date.now() < deadline) {
			try {
				process.kill(pid, 0);
				alive = true;
			} catch {
				alive = false;
			}
			if (!alive) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(alive).toBe(false);
	});
});
