// Plan runs must never carry --dangerously-skip-permissions, even when the
// reviewer agent stages. The CLI does not gate writes under plan mode
// (google-antigravity/antigravity-cli#1181, probed 2026-10-07), so an
// auto-approved plan run is a write-capable run. The agent is a damper, not
// enforcement, and it does not license the flag. AGY_EXTRA_ARGS cannot
// re-inject it (prefix filter: bare and =value spellings, benign args kept).
//
// Harness isolation holds through EXECUTE, not just registration: the
// reviewer agent stages into HOME and loadConfig reads HOME, so both run
// under a temp HOME or the tests touch the host and read host config.
//
// Run: npm test

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, test } from "vitest";
import factory from "../extensions/index.js";
import { strict as assert } from "node:assert";

type RegisteredTool = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: Record<string, unknown>,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

const tempDirs: string[] = [];
afterAll(() => {
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeArgvCapturingAgyBin(argvFile: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-plan-"));
	tempDirs.push(dir);
	const bin = path.join(dir, "agy");
	const script = [
		"#!/usr/bin/env bash",
		`printf '%s\\0' "$@" > ${JSON.stringify(argvFile)}`,
		"echo FAKE OUTPUT",
		"exit 0",
		"",
	].join("\n");
	fs.writeFileSync(bin, script, { mode: 0o755 });
	return bin;
}

const FAKE_CONVERSATION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

async function argvFor(
	mode: string,
	opts: { extraArgs?: string; conversationId?: string } = {},
): Promise<string[]> {
	const argvDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plan-argv-"));
	tempDirs.push(argvDir);
	const argvFile = path.join(argvDir, "argv.txt");
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plan-cwd-"));
	tempDirs.push(cwd);
	const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-plan-"));
	tempDirs.push(emptyHome);

	// Save every env var the tool reads; isolation must survive into execute.
	const saved = {
		HOME: process.env.HOME,
		AGY_BIN: process.env.AGY_BIN,
		AGY_EXTRA_ARGS: process.env.AGY_EXTRA_ARGS,
	};
	process.env.HOME = emptyHome;
	process.env.AGY_BIN = makeArgvCapturingAgyBin(argvFile);
	if (opts.extraArgs === undefined) delete process.env.AGY_EXTRA_ARGS;
	else process.env.AGY_EXTRA_ARGS = opts.extraArgs;

	const restoreEnv = () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};

	try {
		const tools: RegisteredTool[] = [];
		const pi = new Proxy(
			{
				registerTool: (def: { name: string; execute: RegisteredTool["execute"] }) =>
					void tools.push({ name: def?.name, execute: def.execute }),
			} as Record<string | symbol, unknown>,
			{
				get(target, prop: string | symbol) {
					return prop in target ? target[prop] : () => {};
				},
			},
		);
		await factory(pi as never);
		const tool = tools.find((t) => t.name === "AskAntigravity");
		assert.ok(tool, "AskAntigravity tool must register under an isolated HOME");

		const params: Record<string, unknown> = { prompt: "look", mode, cwd };
		if (opts.conversationId !== undefined) params.conversationId = opts.conversationId;
		await tool.execute("t1", params, undefined, undefined, { cwd });
		return fs.readFileSync(argvFile, "utf8").split("\0");
	} finally {
		restoreEnv();
	}
}

test("plan run never carries the skip flag, even with the reviewer agent staged", async () => {
	const argv = await argvFor("plan");
	assert.equal(
		argv.some((a) => a.startsWith("--dangerously-skip-permissions")),
		false,
		"plan run must not be auto-approved: an approved plan run is write-capable (#1181)",
	);
	assert.ok(argv.includes("--agent"), "plan run stages the restricted reviewer agent (damper)");
	assert.ok(argv.includes("--mode"), "mode flag is passed");
});

test("plan continuation runs withhold the flag too", async () => {
	const argv = await argvFor("plan", { conversationId: FAKE_CONVERSATION_ID });
	assert.equal(
		argv.some((a) => a.startsWith("--dangerously-skip-permissions")),
		false,
		"continuation plan runs must not be auto-approved",
	);
	assert.ok(argv.includes("--conversation"), "continuation passes the conversation id");
});

test("AGY_EXTRA_ARGS loses the skip flag on plan runs and keeps benign args", async () => {
	const argv = await argvFor("plan", {
		extraArgs: "--sandbox --dangerously-skip-permissions --dangerously-skip-permissions=true",
	});
	assert.equal(
		argv.some((a) => a.startsWith("--dangerously-skip-permissions")),
		false,
		"env-injected skip flag must be filtered from plan runs",
	);
	assert.ok(argv.includes("--sandbox"), "benign extra args survive the filter");
});

test("accept-edits run keeps the flag (default skipPermissions on)", async () => {
	const argv = await argvFor("accept-edits");
	assert.ok(
		argv.includes("--dangerously-skip-permissions"),
		"accept-edits keeps the flag so commands don't hang on the unanswerable y/n prompt",
	);
});
