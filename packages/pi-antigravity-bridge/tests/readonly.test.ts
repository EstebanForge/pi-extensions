// readOnly + plan-shaped provider turns are fail-closed (issue #3 follow-up,
// probed 2026-10-07, upstream google-antigravity/antigravity-cli#1181: NO agy
// path enforces review-only - plan mode stages a plan and executes the write
// in the same turn on -p and stream-json alike). Tests: config precedence
// (fail-closed env parse), the visible turn refusal on both engines, and the
// ask tool (readOnly refuses the tool entirely; config mode plan defaults the
// delegation to plan; plan runs never get the skip flag). All env-driven:
// AGY_READONLY / AGY_MODE win over any on-disk config, so tests never touch
// the real config file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "../src/config.js";
import { createStreamSimple, ToolRoundTrips } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { StreamDriver, DriverTurnRequest } from "../src/driver.js";
import type { Model, Api } from "@earendil-works/pi-ai";
import { normalizeContext, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";

// Helpers that create temp dirs register them here; vitest's global afterAll
// removes them (captureTurn and the argv-capturing bin have no natural finally).
const tempDirs: string[] = [];
afterAll(() => {
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function withEnvsSync<T>(values: Record<string, string | undefined>, fn: () => T): T {
	const prevs = Object.entries(values).map(([k]) => [k, process.env[k]] as const);
	for (const [k, v] of Object.entries(values)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return fn();
	} finally {
		for (const [k, prev] of prevs) {
			if (prev === undefined) delete process.env[k];
			else process.env[k] = prev;
		}
	}
}

async function withEnvs(values: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	// Await fn INSIDE the env window: restoring in a sync finally around a
	// returned promise would unset AGY_READONLY/AGY_BIN while the tool body is
	// still awaiting, and the run would silently fall through to the real agy.
	const prevs = Object.entries(values).map(([k]) => [k, process.env[k]] as const);
	for (const [k, v] of Object.entries(values)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		await fn();
	} finally {
		for (const [k, prev] of prevs) {
			if (prev === undefined) delete process.env[k];
			else process.env[k] = prev;
		}
	}
}

// --- 1. Config precedence ---------------------------------------------------

test("config: AGY_READONLY env wins over file; file key parses; default false", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-config-"));
	const cfgPath = path.join(dir, "config.json");
	try {
		// Default: absent everywhere.
		const off = withEnvsSync({ AGY_READONLY: undefined }, () => loadConfig(cfgPath));
		assert.equal(off.readOnly, false);
		// File key on.
		fs.writeFileSync(cfgPath, JSON.stringify({ readOnly: true }));
		const fromFile = withEnvsSync({ AGY_READONLY: undefined }, () => loadConfig(cfgPath));
		assert.equal(fromFile.readOnly, true);
		// Env wins over the file (off): explicit falsities.
		fs.writeFileSync(cfgPath, JSON.stringify({ readOnly: true }));
		assert.equal(withEnvsSync({ AGY_READONLY: "0" }, () => loadConfig(cfgPath)).readOnly, false);
		assert.equal(withEnvsSync({ AGY_READONLY: "false" }, () => loadConfig(cfgPath)).readOnly, false);
		assert.equal(withEnvsSync({ AGY_READONLY: "off" }, () => loadConfig(cfgPath)).readOnly, false);
		assert.equal(withEnvsSync({ AGY_READONLY: "" }, () => loadConfig(cfgPath)).readOnly, false);
		// Fail-closed parse: env set to anything else means ON. A safety knob
		// must not silently turn off on typos or unexpected spellings.
		fs.writeFileSync(cfgPath, JSON.stringify({ readOnly: false }));
		assert.equal(withEnvsSync({ AGY_READONLY: "1" }, () => loadConfig(cfgPath)).readOnly, true);
		assert.equal(withEnvsSync({ AGY_READONLY: "true" }, () => loadConfig(cfgPath)).readOnly, true);
		assert.equal(withEnvsSync({ AGY_READONLY: "on" }, () => loadConfig(cfgPath)).readOnly, true);
		assert.equal(withEnvsSync({ AGY_READONLY: " 1" }, () => loadConfig(cfgPath)).readOnly, true);
		assert.equal(withEnvsSync({ AGY_READONLY: "yes-please" }, () => loadConfig(cfgPath)).readOnly, true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// --- 2. Provider fail-closed refusals ---------------------------------------

const model: Model<Api> = {
	id: "gemini-flash",
	name: "Gemini Flash",
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

function capturingDriver(seen: { opts?: DriverTurnRequest }): StreamDriver {
	return {
		run: async (opts: DriverTurnRequest) => {
			seen.opts = opts;
			return {
				id: "fake-turn",
				outcome: Promise.resolve({ status: "OK", response: "ok", finished: true, aborted: false }),
				next: async () => null,
				pushExternal: () => {},
			};
		},
	} as unknown as StreamDriver;
}

async function captureTurn(
	engine: "stream-json" | "acp",
): Promise<{ opts?: DriverTurnRequest; events: unknown[] }> {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = capturingDriver(seen);
	const roDir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-prov-"));
	tempDirs.push(roDir);
	const streamSimple = createStreamSimple({
		entries: [],
		store: new SessionStore(path.join(roDir, "sessions.json")),
		driver,
		// Give the acp path its own captured driver so an acp regression that
		// skipped the refusal would land here, not silently in deps.driver.
		acpDriver: engine === "acp" ? capturingDriver(seen) : undefined,
		roundTrips: new ToolRoundTrips(driver),
		engine,
	});
	const stream = streamSimple(
		{ ...model },
		contextWith("ignored by fake"),
		{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
	);
	const events: unknown[] = [];
	for await (const ev of stream) events.push(ev);
	return { opts: seen.opts, events };
}

test("provider: readOnly turn is refused on stream-json (fail-closed, no driver run)", async () => {
	await withEnvs({ AGY_READONLY: "1", AGY_MODE: "accept-edits" }, async () => {
		const { opts, events } = await captureTurn("stream-json");
		assert.equal(opts, undefined, "refused turns must not reach the driver");
		assert.match(JSON.stringify(events), /readOnly cannot be enforced on provider turns/);
	});
});

test("provider: /agy mode plan is refused on stream-json too (probed: writes execute anyway)", async () => {
	await withEnvs({ AGY_READONLY: "0", AGY_MODE: "plan" }, async () => {
		const { opts, events } = await captureTurn("stream-json");
		assert.equal(opts, undefined);
		assert.match(JSON.stringify(events), /Plan mode cannot be enforced on provider turns/);
	});
});

test("provider: plan turn is refused on ACP (RC01, unified message)", async () => {
	await withEnvs({ AGY_READONLY: "0", AGY_MODE: "plan" }, async () => {
		const { opts, events } = await captureTurn("acp");
		assert.equal(opts, undefined);
		assert.match(JSON.stringify(events), /Plan mode cannot be enforced on provider turns/);
	});
});

test("provider: readOnly on ACP refuses with the readOnly message", async () => {
	await withEnvs({ AGY_READONLY: "1", AGY_MODE: "accept-edits" }, async () => {
		const { opts, events } = await captureTurn("acp");
		assert.equal(opts, undefined);
		assert.match(JSON.stringify(events), /readOnly cannot be enforced on provider turns/);
	});
});

test("provider: readOnly wins over mode plan in the refusal message", async () => {
	await withEnvs({ AGY_READONLY: "1", AGY_MODE: "plan" }, async () => {
		const { events } = await captureTurn("stream-json");
		const s = JSON.stringify(events);
		assert.match(s, /readOnly cannot be enforced on provider turns/);
		assert.doesNotMatch(s, /Plan mode cannot be enforced/);
	});
});

test("provider: refusals finalize exactly once (single occurrence of the message)", async () => {
	await withEnvs({ AGY_READONLY: "1", AGY_MODE: "accept-edits" }, async () => {
		const { events } = await captureTurn("stream-json");
		const occurrences = (JSON.stringify(events).match(/readOnly cannot be enforced on provider turns/g) || []).length;
		assert.equal(occurrences, 1, "the refusal text must appear exactly once in the stream");
	});
});

test("provider: normal accept-edits turn still reaches the driver unchanged", async () => {
	await withEnvs({ AGY_READONLY: "0", AGY_MODE: "accept-edits" }, async () => {
		const { opts } = await captureTurn("stream-json");
		assert.ok(opts, "the working config must not be refused");
		assert.equal(opts.mode, "accept-edits");
	});
});

// --- 3. AskAntigravity default mode ------------------------------------------

type RegisteredTool = {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: Record<string, unknown>,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

async function registerTool(): Promise<RegisteredTool> {
	const tools: RegisteredTool[] = [];
	const fakePi = {
		registerTool: (tool: RegisteredTool) => tools.push(tool),
	} as unknown as ExtensionAPI;
	const { registerAskAntigravityTool } = await import("../src/ask-tool.js");
	await registerAskAntigravityTool(fakePi, []);
	assert.equal(tools.length, 1);
	return tools[0];
}

function makeArgvCapturingAgyBin(argvFile: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-agy-bin-"));
	tempDirs.push(dir);
	const bin = path.join(dir, "agy");
	const script = [
		"#!/usr/bin/env bash",
		`printf '%s\\0' "$@" > ${JSON.stringify(argvFile)}`,
		"echo ok",
		"exit 0",
		"",
	].join("\n");
	fs.writeFileSync(bin, script, { mode: 0o755 });
	return bin;
}

test("ask tool: AGY_READONLY refuses the tool entirely (fail-closed, even with an explicit mode)", async () => {
	const agentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ro-ask-agents-"));
	const argvFile = path.join(agentsRoot, "argv.txt");
	const tool = await registerTool();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ro-ask-cwd-"));
	try {
		await withEnvs(
			{
				AGY_READONLY: "1",
				AGY_AGENTS_ROOT: agentsRoot,
				AGY_BIN: makeArgvCapturingAgyBin(argvFile),
			},
			async () => {
				// No explicit mode: refused.
				const r1 = await tool.execute("t1", { prompt: "look", cwd }, undefined, undefined, { cwd });
				assert.match(r1.content[0].text, /readOnly is on: AskAntigravity is refused/);
				// Explicit mode must NOT beat the kill switch.
				const r2 = await tool.execute("t2", { prompt: "look", mode: "plan", cwd }, undefined, undefined, { cwd });
				assert.match(r2.content[0].text, /readOnly is on: AskAntigravity is refused/);
				assert.equal(r2.content[0].text, r1.content[0].text);
				// The refusal fires before any spawn: the fake binary never ran.
				assert.equal(fs.existsSync(argvFile), false, "agy must not be spawned under readOnly");
			},
		);
	} finally {
		fs.rmSync(agentsRoot, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("ask tool: config mode plan defaults the delegation to plan with no skip flag", async () => {
	const agentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ro-ask-agents-"));
	const argvFile = path.join(agentsRoot, "argv.txt");
	const tool = await registerTool();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ro-ask-cwd-"));
	try {
		await withEnvs(
			{
				AGY_READONLY: undefined,
				AGY_MODE: "plan",
				AGY_AGENTS_ROOT: agentsRoot,
				AGY_BIN: makeArgvCapturingAgyBin(argvFile),
			},
			async () => {
				await tool.execute("t1", { prompt: "look", cwd }, undefined, undefined, { cwd });
				const argv = fs.readFileSync(argvFile, "utf8").split("\0");
				const modeIdx = argv.indexOf("--mode");
				assert.ok(modeIdx !== -1);
				assert.equal(argv[modeIdx + 1], "plan", "config mode plan must default the delegation to plan");
				assert.ok(argv.includes("--agent"), "plan delegation stages the reviewer agent");
				assert.equal(
					argv.includes("--dangerously-skip-permissions"),
					false,
					"plan runs never carry the skip flag (upstream #1181: an auto-approved plan run is write-capable)",
				);
			},
		);
	} finally {
		fs.rmSync(agentsRoot, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("ask tool: accept-edits default keeps the skip flag", async () => {
	const agentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ro-ask-agents-"));
	const argvFile = path.join(agentsRoot, "argv.txt");
	const tool = await registerTool();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ro-ask-cwd-"));
	try {
		await withEnvs(
			{
				AGY_READONLY: undefined,
				AGY_MODE: "accept-edits",
				AGY_AGENTS_ROOT: agentsRoot,
				AGY_BIN: makeArgvCapturingAgyBin(argvFile),
			},
			async () => {
				await tool.execute("t1", { prompt: "look", cwd }, undefined, undefined, { cwd });
				const argv = fs.readFileSync(argvFile, "utf8").split("\0");
				const modeIdx = argv.indexOf("--mode");
				assert.equal(argv[modeIdx + 1], "accept-edits");
				assert.ok(argv.includes("--dangerously-skip-permissions"), "accept-edits needs the flag to avoid the unanswerable prompt");
			},
		);
	} finally {
		fs.rmSync(agentsRoot, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("ask tool: AGY_EXTRA_ARGS cannot re-inject the skip flag on plan runs", async () => {
	const agentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ro-ask-agents-"));
	const argvFile = path.join(agentsRoot, "argv.txt");
	const tool = await registerTool();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ro-ask-cwd-"));
	try {
		await withEnvs(
			{
				AGY_READONLY: undefined,
				AGY_MODE: "plan",
				AGY_EXTRA_ARGS: "--dangerously-skip-permissions --dangerously-skip-permissions=true",
				AGY_AGENTS_ROOT: agentsRoot,
				AGY_BIN: makeArgvCapturingAgyBin(argvFile),
			},
			async () => {
				await tool.execute("t1", { prompt: "look", cwd }, undefined, undefined, { cwd });
				const argv = fs.readFileSync(argvFile, "utf8").split("\0");
				assert.equal(
					argv.some((a) => a.startsWith("--dangerously-skip-permissions")),
					false,
					"env-injected skip flag (bare or =value) must be filtered from plan runs",
				);
			},
		);
	} finally {
		fs.rmSync(agentsRoot, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveConfig: env overrides are not baked into the file; null nested keys tolerated", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-save-"));
	const cfgPath = path.join(dir, "config.json");
	try {
		// Legacy/hand-edited file: readOnly false on disk, null nested objects,
		// plus a legacy approvals key that normalization must drop.
		fs.writeFileSync(
			cfgPath,
			JSON.stringify({ readOnly: false, acp: null, approvals: { legacy: true } }),
		);
		withEnvsSync({ AGY_READONLY: "1" }, () => {
			const saved = saveConfig({ mode: "accept-edits" }, cfgPath);
			// The persisted merge follows the FILE (env must not bake in)...
			assert.equal(saved.readOnly, false);
			// ...while loadConfig still honors the env at read time.
			assert.equal(loadConfig(cfgPath).readOnly, true);
			const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
			assert.equal(raw.readOnly, false, "env-derived values must not persist to disk");
			assert.equal(raw.mode, "accept-edits");
			// The null nested objects were normalized instead of crashing.
			assert.deepEqual(raw.acp, { bin: "", usageEstimate: "estimate" });
			assert.deepEqual(raw.approvals, { gateMode: "auto", mode: "ask" });
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
