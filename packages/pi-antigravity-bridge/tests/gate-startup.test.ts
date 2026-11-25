// Approval-gate startup through the real factory: the shadow bash replaces
// pi's bash for every model, so it must keep pi's shell settings, and the
// gate must stage even when bridgeTools hides every pi tool. Runs the
// session_start handlers against a temp agent dir; the ctx Proxy absorbs
// whatever else the startup path touches.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import factory from "../extensions/index.js";
import type { AnyToolDefinition } from "../src/approval-gate.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;

const AGY_ENV_KEYS = ["AGY_ENGINE", "AGY_APPROVALS", "AGY_APPROVALS_MODE", "AGY_BRIDGE_TOOLS"] as const;

function nooped<T extends object>(base: T): T {
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			return () => {};
		},
	}) as T;
}

/** Start one session with the given bridge config and pi settings; return
 *  the tools it registered by name, and a shutdown hook. */
async function startSession(
	config: Record<string, unknown>,
	settings: { shellCommandPrefix?: string; shellPath?: string },
): Promise<{ tools: Map<string, AnyToolDefinition>; shutdown: () => Promise<void> }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-gate-"));
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(path.join(agentDir, "antigravity-bridge"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "antigravity-bridge", "config.json"), JSON.stringify(config));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	const prevEnvs = AGY_ENV_KEYS.map((k) => [k, process.env[k]] as const);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const k of AGY_ENV_KEYS) delete process.env[k];
	const restore = () => {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		for (const [k, prev] of prevEnvs) {
			if (prev === undefined) delete process.env[k];
			else process.env[k] = prev;
		}
	};
	const tools = new Map<string, AnyToolDefinition>();
	const handlers: Record<string, Handler[]> = {};
	const pi = nooped({
		registerTool: (tool: AnyToolDefinition) => {
			tools.set(tool.name, tool);
		},
		getSettings: () => settings,
		getAllTools: () => [],
		getActiveTools: () => [],
		on: (name: string, handler: Handler) => {
			(handlers[name] ??= []).push(handler);
		},
	}) as unknown as ExtensionAPI;
	const ctx = nooped({
		hasUI: false,
		mode: "print",
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		sessionManager: { getEntries: () => [] },
	});
	try {
		await factory(pi);
		for (const h of handlers["session_start"] ?? []) await h({ reason: "startup" }, ctx);
	} catch (err) {
		restore();
		throw err;
	}
	return {
		tools,
		shutdown: async () => {
			try {
				for (const h of handlers["session_shutdown"] ?? []) await h({ reason: "quit" }, ctx);
			} finally {
				restore();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

async function runBash(tool: AnyToolDefinition, command: string): Promise<string> {
	const result = await tool.execute("call-1", { command }, undefined, undefined, undefined as never);
	return result.content.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : "")).join("");
}

const gateOn = { engine: "stream-json", approvals: { gateMode: "shadow", mode: "allow" } };

test("gate startup: shadow bash keeps pi's shellCommandPrefix", { timeout: 30000 }, async () => {
	const session = await startSession(gateOn, { shellCommandPrefix: "export AGY_GATE_PROBE=prefixed" });
	try {
		const bash = session.tools.get("bash");
		assert.ok(bash, "gate on must register the bash shadow");
		assert.equal((await runBash(bash, 'printf %s "$AGY_GATE_PROBE"')).trim(), "prefixed");
	} finally {
		await session.shutdown();
	}
});

test("gate startup: shadow bash keeps pi's shellPath", { timeout: 30000 }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-shell-"));
	const shell = path.join(dir, "probe-shell");
	// A shell wrapper that marks every command it runs.
	fs.writeFileSync(shell, '#!/bin/sh\nexport AGY_SHELL_PROBE=wrapped\nexec /bin/sh "$@"\n', { mode: 0o755 });
	const session = await startSession(gateOn, { shellPath: shell });
	try {
		const bash = session.tools.get("bash");
		assert.ok(bash, "gate on must register the bash shadow");
		assert.equal((await runBash(bash, 'printf %s "$AGY_SHELL_PROBE"')).trim(), "wrapped");
	} finally {
		await session.shutdown();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("gate startup: bridgeTools none still stages a forced gate", { timeout: 30000 }, async () => {
	const session = await startSession({ ...gateOn, bridgeTools: "none" }, {});
	try {
		for (const name of ["bash", "write", "edit"]) {
			assert.ok(session.tools.has(name), `bridgeTools none must not drop the ${name} shadow`);
		}
	} finally {
		await session.shutdown();
	}
});

test("gate startup: bridgeTools none with the gate off registers no shadows", { timeout: 30000 }, async () => {
	const session = await startSession(
		{ engine: "stream-json", bridgeTools: "none", approvals: { gateMode: "off" } },
		{},
	);
	try {
		for (const name of ["bash", "write", "edit"]) assert.ok(!session.tools.has(name), `unexpected ${name} shadow`);
	} finally {
		await session.shutdown();
	}
});
