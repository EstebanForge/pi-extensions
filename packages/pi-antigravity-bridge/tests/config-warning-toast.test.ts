// The startup config warning (issue #23): a hand editor never runs /agy, so
// parse fallbacks must surface where they happen. Runs the real factory's
// session_start handlers against a temp agent dir and a capture ui; the ctx
// Proxy absorbs whatever else the startup path touches (setup probes, MCP
// bridge wiring) so the test pins only the warning behavior.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import factory from "../extensions/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;

const AGY_ENV_KEYS = [
	"AGY_ASK_TOOL",
	"AGY_WEB_TOOLS",
	"AGY_DIGEST",
	"AGY_SYSTEM_PROMPT",
	"AGY_SKIP_PERMISSIONS",
	"AGY_READONLY",
	"AGY_ACP_SESSION_RETRY",
] as const;

function nooped<T extends object>(base: T): T {
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			return () => {};
		},
	}) as T;
}

function tempAgentDir(withConfig: Record<string, unknown> | null): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-toast-"));
	const agentDir = path.join(dir, "agent");
	if (withConfig) {
		// configPath() = <agentDir>/antigravity-bridge/config.json
		fs.mkdirSync(path.join(agentDir, "antigravity-bridge"), { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "antigravity-bridge", "config.json"),
			JSON.stringify(withConfig),
		);
	} else {
		fs.mkdirSync(agentDir, { recursive: true });
	}
	return agentDir;
}

async function startupNotes(agentDir: string): Promise<string[]> {
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	const prevEnvs = AGY_ENV_KEYS.map((k) => [k, process.env[k]] as const);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const k of AGY_ENV_KEYS) delete process.env[k];
	const notes: string[] = [];
	const handlers: Record<string, Handler[]> = {};
	const pi = nooped({
		registerTool: () => {},
		on: (name: string, handler: Handler) => {
			(handlers[name] ??= []).push(handler);
		},
	}) as unknown as ExtensionAPI;
	try {
		await factory(pi);
		const ctx = nooped({
			hasUI: true,
			mode: "tui",
			ui: nooped({ notify: (message: string) => notes.push(message) }),
			sessionManager: { getEntries: () => [] },
		});
		for (const h of handlers["session_start"] ?? []) await h({ reason: "startup" }, ctx);
	} finally {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		for (const [k, prev] of prevEnvs) {
			if (prev === undefined) delete process.env[k];
			else process.env[k] = prev;
		}
		fs.rmSync(path.dirname(agentDir), { recursive: true, force: true });
	}
	return notes;
}

test("toast: junk config booleans warn on startup with the doctor pointer", { timeout: 30000 }, async () => {
	const notes = await startupNotes(tempAgentDir({ skipPermissions: "banana" }));
	assert.ok(
		notes.some((n) => /config\.json/.test(n) && /unparseable/.test(n) && /\/agy doctor/.test(n)),
		`expected a config warning toast, got: ${JSON.stringify(notes)}`,
	);
});

test("toast: a clean config emits no config warning", { timeout: 30000 }, async () => {
	const notes = await startupNotes(tempAgentDir({}));
	assert.ok(
		!notes.some((n) => /config\.json/.test(n) && /unparseable/.test(n)),
		`clean config must not warn, got: ${JSON.stringify(notes)}`,
	);
});
