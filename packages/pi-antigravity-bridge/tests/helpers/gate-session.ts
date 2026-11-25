// Shared factory-level gate startup harness: runs the real extension
// factory's session_start in a scratch HOME, agent dir, and workspace with a
// stub agy (AGY_BIN), so startup sweeps and registration never touch the
// user's real config or spawn the real CLI; the ctx Proxy absorbs whatever
// else the startup path touches.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import factory from "../../extensions/index.js";
import type { AnyToolDefinition } from "../../src/approval-gate.js";
import type { BridgeStreamSimple } from "../../src/runtime.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;

const AGY_ENV_KEYS = ["AGY_ENGINE", "AGY_APPROVALS", "AGY_APPROVALS_MODE", "AGY_BRIDGE_TOOLS"] as const;
const SCRATCH_ENV_KEYS = ["PI_CODING_AGENT_DIR", "HOME", "AGY_BIN"] as const;

/** Minimal Antigravity model ref for driving the registered streamSimple. */
export const probeModel: Model<Api> = {
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

function nooped<T extends object>(base: T): T {
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			return () => {};
		},
	}) as T;
}

export interface GateSession {
	tools: Map<string, AnyToolDefinition>;
	home: string;
	cwd: string;
	providerDef: { streamSimple?: BridgeStreamSimple } | undefined;
	shutdown: () => Promise<void>;
}

/** Start one session with the given bridge config and pi settings. `settings`
 *  may be a throwing function to simulate a skewed host. */
export async function startSession(
	config: Record<string, unknown>,
	settings: { shellCommandPrefix?: string; shellPath?: string } | (() => never),
): Promise<GateSession> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-gate-"));
	const agentDir = path.join(dir, "agent");
	const home = path.join(dir, "home");
	const workspace = path.join(dir, "workspace");
	fs.mkdirSync(path.join(agentDir, "antigravity-bridge"), { recursive: true });
	fs.mkdirSync(home);
	fs.mkdirSync(workspace);
	fs.writeFileSync(path.join(agentDir, "antigravity-bridge", "config.json"), JSON.stringify(config));
	// Stub agy: model discovery and version probes fail fast instead of
	// spawning the real CLI.
	const agy = path.join(dir, "agy");
	fs.writeFileSync(agy, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	const prevEnvs = [...AGY_ENV_KEYS, ...SCRATCH_ENV_KEYS].map((k) => [k, process.env[k]] as const);
	const prevCwd = process.cwd();
	for (const k of AGY_ENV_KEYS) delete process.env[k];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HOME = home;
	process.env.AGY_BIN = agy;
	process.chdir(workspace);
	const restore = () => {
		process.chdir(prevCwd);
		for (const [k, prev] of prevEnvs) {
			if (prev === undefined) delete process.env[k];
			else process.env[k] = prev;
		}
	};
	const tools = new Map<string, AnyToolDefinition>();
	const handlers: Record<string, Handler[]> = {};
	let providerDef: { streamSimple?: BridgeStreamSimple } | undefined;
	const pi = nooped({
		registerTool: (tool: AnyToolDefinition) => {
			tools.set(tool.name, tool);
		},
		registerProvider: (_name: string, def: { streamSimple?: BridgeStreamSimple }) => {
			providerDef = def;
		},
		getSettings: typeof settings === "function" ? settings : () => settings,
		getAllTools: () => [],
		getActiveTools: () => [],
		on: (name: string, handler: Handler) => {
			(handlers[name] ??= []).push(handler);
		},
	}) as unknown as ExtensionAPI;
	const ctx = nooped({
		hasUI: false,
		mode: "print",
		cwd: workspace,
		isProjectTrusted: () => false,
		sessionManager: { getEntries: () => [] },
	});
	// Runs on BOTH the success and the session_start-failure path: a failed
	// startup that already attached the bridge must still leave the realm and
	// remove the scratch dir, or the next session inherits its server.
	const runShutdown = async () => {
		try {
			for (const h of handlers["session_shutdown"] ?? []) await h({ reason: "quit" }, ctx);
		} finally {
			restore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	};
	try {
		await factory(pi);
		for (const h of handlers["session_start"] ?? []) await h({ reason: "startup" }, ctx);
	} catch (err) {
		try {
			await runShutdown();
		} catch {
			// the session_start failure is the one that surfaces
		}
		throw err;
	}
	return { tools, home, cwd: workspace, providerDef, shutdown: runShutdown };
}

export function globalBridgeEntry(home: string): string {
	const file = path.join(home, ".gemini", "config", "mcp_config.json");
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}
