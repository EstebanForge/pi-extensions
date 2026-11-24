// Runtime config for the antigravity provider. Persisted at
// <agentDir>/antigravity-bridge/config.json so the /agy command can
// toggle settings that take effect on the next turn.
//
// Knobs today:
//   mode            "accept-edits" (default) or "plan". Drives agy's --mode.
//   skipPermissions true (default). Passes --dangerously-skip-permissions so
//                   commands don't hang on an unanswerable prompt in -p mode.
//
// Env overrides (AGY_MODE, AGY_SKIP_PERMISSIONS) win over the file so tests
// and one-off runs can force a setting without editing the file.

import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeAgyAgentName } from "./agents.js";
import { writeJsonAtomic } from "./atomic-write.js";

/** pi's agent dir (env override PI_CODING_AGENT_DIR, else ~/.pi/agent); every
 *  bridge-owned path derives from it so isolated or rebranded pi homes keep
 *  their state together (issue #17). */
export function bridgeDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "antigravity-bridge");
}

export function configPath(agentDir: string = getAgentDir()): string {
	return path.join(bridgeDir(agentDir), "config.json");
}

/** Scoped extensions-data convention shared with other EstebanForge
 *  extensions: <configRoot>/extensions-data/<author>/<name>, anchored at
 *  dirname(getAgentDir()) so it relocates with the agent dir too. */
export function extensionsDataDir(agentDir: string = getAgentDir()): string {
	return path.join(path.dirname(agentDir), "extensions-data", "estebanforge", "pi-antigravity-bridge");
}

/** Daily debug logs land here, sorted by day, for post-mortems and user
 *  support (see src/daily-log.ts). */
export function logsDir(agentDir: string = getAgentDir()): string {
	return path.join(extensionsDataDir(agentDir), "logs");
}

/** Native `agy acp` is the default for new installs; stream-json remains
 *  a fully supported fallback. */
export type Engine = "stream-json" | "acp";

/** The engine a fresh install runs when nothing is configured (no file key,
 *  no AGY_ENGINE): the official ACP server. Unknown/stale stored values also
 *  fall back here. Startup checks that the required agy CLI is available. */
export const DEFAULT_ENGINE: Engine = "acp";
export type AgyMode = "accept-edits" | "plan";
export type ThinkingTier = "low" | "medium" | "high" | "xhigh";
export type BridgeTools = "none" | "mcp" | "all";

/** How ACP turns report token usage while Gate B stands (agy sends none).
 *  "estimate" (default): word-boundary regex over prompt/response/thought
 *  text (pi-token-speed's mechanism). "direct": 1 token per streamed delta.
 *  "off": keep zero-usage. Real server usage (usageSeen latch) always wins. */
export type UsageEstimate = "estimate" | "direct" | "off";

/** How the approval gate activates (docs/TODO.md section 2.5).
 *
 *  "auto" (default): OFF until a third-party pi permission extension is
 *  detected (src/approval-detect.ts). When one is found, the gate runs in
 *  "shadow" mode so that extension gates agy's native tool calls with zero
 *  configuration on its side.
 *
 *  "shadow" / "dedicated": force the gate on in that shape. "off": never
 *  gate, even when a permission extension is installed. NOTE: "dedicated"
 *  currently stages the same shadow tools as "shadow" (warn-logged remap);
 *  the explicit antigravity_approve variant is planned - see docs/TODO.md. */
export type GateMode = "auto" | "shadow" | "dedicated" | "off";

/** Fallback decision when no extension blocked a gated call: "ask" uses
 *  ctx.ui.confirm (headless = deny, fail-closed), "allow" auto-approves,
 *  "deny" auto-rejects. */
export type GateAskMode = "ask" | "allow" | "deny";

export interface GateConfig {
	gateMode: GateMode;
	mode: GateAskMode;
}

export interface AcpConfig {
	/** Gate B stopgap: client-side token estimates for ACP turns so pi's
	 *  usage surfaces show nonzero numbers. Estimates are labeled as such in
	 *  /agy doctor and auto-disable when the server sends real usage. */
	usageEstimate: UsageEstimate;
	/** Timeout in ms for ACP session operations (session/new, session/load,
	 *  session/set_config_option, session/close). Default 20000 (20s); valid
	 *  range 1000..300000. Env AGY_ACP_SESSION_TIMEOUT_MS wins over the file. */
	sessionTimeoutMs: number;
	/** Advanced: transparently retry session/new once when it times out while
	 *  the ACP server is still alive. Default false. Warning: doubles the wait
	 *  on genuinely dead networks (e.g. 40s at default 20s timeout) and may not
	 *  recover if the server process itself has a wedged socket.
	 *  Env AGY_ACP_SESSION_RETRY wins over the file. */
	sessionRetryOnTimeout: boolean;
}

export interface AgyConfig {
	/** Engine. Switching requires a pi restart (drivers wire at load). */
	engine: Engine;
	/** Official-server ACP engine options (used when engine = "acp"). */
	acp: AcpConfig;
	mode: AgyMode;
	/** Fail-closed kill switch for provider turns. ON = every provider turn
	 *  is refused visibly: the agy CLI has no review-only enforcement on any
	 *  path (probed 2026-10-07, upstream #1181: plan mode stages a plan and
	 *  executes the write in the same turn on -p and stream-json alike; the
	 *  provider plan turns are refused on ACP too). Built for callers like
	 *  `pi -p --no-tools` health checks that must never mutate a workspace
	 *  and prefer a visible refusal over a write-capable turn. Wins over
	 *  `mode`; the AskAntigravity delegation tool is refused while this is on
	 *  (the CLI has no review-only enforcement, so nothing here can run
	 *  read-only). Env AGY_READONLY wins over the file.
	 *  Default false. */
	readOnly: boolean;
	/** Auto-approve all agy tool permission requests (--dangerously-skip-permissions).
	 *  Required for non-interactive use: without it, any `run_command` triggers an
	 *  interactive y/n prompt that hangs forever in `-p` mode. Defaults true.
	 *  DANGEROUS: lets agy run arbitrary commands (including destructive ones)
	 *  without review. The ask tool withholds the flag on plan runs;
	 *  accept-edits runs need it to avoid hanging on the unanswerable prompt. */
	skipPermissions: boolean;
	/** AskAntigravity tool: default model alias (flash/pro/gemini or exact). */
	defaultModel: string;
	/** AskAntigravity tool: default thinking tier when the alias names none. */
	defaultThinking: ThinkingTier;
	/** Register the AskAntigravity one-shot delegation tool. Default on.
	 *  off removes the tool entirely for users who want only the provider
	 *  and models (no delegation tool in the model's window context).
	 *  Takes effect at pi start (or /reload). */
	askTool: boolean;
	/** Register the agy_web_search + agy_read_url Pi tools. Default OFF:
	 *  inside Antigravity sessions the model already has native web tools;
	 *  these exist for NON-Antigravity provider sessions and every call
	 *  spends Antigravity quota. Takes effect at pi start (or /reload). */
	webTools: boolean;
	/** Set after the one-time notice about a leftover legacy invokeTool patch
	 *  on the installed pi. The notice never repeats; /agy patch-cleanup is
	 *  always available. */
	patchCleanupNotified?: boolean;
	/** config.json values that were present but unparseable and fell back or
	 *  failed closed (issue #23). Surfaced by /agy doctor; undefined when
	 *  every value parsed. Computed per load, never persisted by saveConfig. */
	parseWarnings?: string[];
	/** Custom agy agent for stream-json turns (`--agent`, /agy agent).
	 *  Absent = agy's default agent. ACP turns ignore it (no protocol slot). */
	agent?: string;
	/** Which pi tools the MCP bridge exposes to agy: "none" (bridge off),
	 *  "all" (every registered non-builtin tool incl. other Ask* delegations;
	 *  default - users expect the bridge working out of the box, and the
	 *  "mcp" surface serves an empty catalog on installs without
	 *  pi-mcp-adapter), "mcp" (pi-mcp-adapter tools + skills bridge only). */
	bridgeTools: BridgeTools;
	/** Extra pi tool names that get the long (120s) synchronous escalation
	 *  window, in addition to delegation-shaped names (subagent_run,
	 *  agent_spawn/agent_wait, *delegate*; issue #6). For custom tools that
	 *  legitimately run minutes-long but must return a plain result to an
	 *  orchestrator. Env AGY_ESCALATE_LONG_TOOLS (comma-separated) wins over
	 *  the file. Takes effect on the next bridge call. */
	escalateLongTools?: string[];
	/** Inject a delta digest of pi-side context (compaction summaries, turns
	 *  handled by other providers or pi's own tools) into agy prompts.
	 *
	 *  Default ON. The digest is self-gating: it ships only when the delta
	 *  window is non-empty (a fresh agy conversation from a mid-session model
	 *  switch or engine switch, another provider's turns, pi-side tool runs,
	 *  or a compaction summary), and each piece ships once. Pure antigravity
	 *  sessions get an empty delta, byte-stable prompts, and an intact
	 *  server-side prompt cache.
	 *
	 *  Turn off for agy-native behavior: prompts then contain only your
	 *  message, and a conversation opened mid-session starts without prior
	 *  pi-side context. */
	digest: boolean;
	/** Migration marker (issue #25): set once when a stale persisted
	 *  digest:false from the pre-default-flip era is upgraded to the ON
	 *  default. Presence keeps later deliberate `/agy digest off` choices
	 *  from being re-migrated. */
	digestMigrated?: boolean;
	/** Prepend pi's composed system prompt (pi tool guidance + the global
	 *  agent-dir AGENTS.md and ancestor AGENTS.md/CLAUDE.md) to the FIRST
	 *  prompt of each fresh agy conversation.
	 *
	 *  Default ON: agy keeps its own history, so the prefix is sent once per
	 *  conversation and stays byte-identical afterwards - agy's server-side
	 *  prompt cache keeps hitting. This is why it is safe here while the G1
	 *  digest (per-turn) is not. Turn off for agy-native behavior (agy's own
	 *  system prompt only). */
	systemPrompt: boolean;
	/** Overall cap on ONE agy turn in minutes, both engines. When it fires, the
	 *  bridge kills the agy process mid-task ("ACP turn exceeded the Xm
	 *  deadline" / "agy exceeded the Xm turn timeout"). The ACP server binary
	 *  exposes no timeout flag of its own (--helpfull: debug/notices only), so
	 *  this bridge cap is the only knob.
	 *
	 *  Default is TTY-aware: 0 (no cap) on an interactive pi - the user aborts
	 *  with Esc and is the better backstop - and 20 on headless runs, where
	 *  nobody can abort and one runaway turn blocks the drivers' serialized
	 *  turn queue. Explicit values opt into the gate: 1..1440 valid, 0
	 *  disables, anything else (garbage, negative, >1440) falls back to the
	 *  TTY-aware default. The inactivity stall guard (5m silence) still bounds
	 *  a hung server either way. Next-turn effect. Env AGY_TURN_TIMEOUT_MIN
	 *  wins over the file. */
	turnTimeoutMin: number;
	/** Silence cap in minutes, both engines: no stream-json stdout / no ACP
	 *  session/update for this long fails the turn as a stall. Default 5;
	 *  0 disables the guard. Next-turn effect.
	 *  Env AGY_INACTIVITY_TIMEOUT_MIN wins over the file. */
	inactivityTimeoutMin: number;
	/** Approval gate over agy NATIVE tool calls (create_file, run_command,
	 *  ...). pi tools agy calls already pass through pi's gates via the G9
	 *  round-trip; this covers the rest. Default auto (off until a
	 *  third-party permission extension is detected). See docs/TODO.md 2.5. */
	approvals: GateConfig;
}

const DEFAULTS: AgyConfig = {
	engine: DEFAULT_ENGINE,
	mode: "accept-edits",
	readOnly: false,
	skipPermissions: true,
	defaultModel: "gemini-4-hydrogen",
	defaultThinking: "medium",
	askTool: true,
	webTools: false,
	bridgeTools: "all",
	digest: true,
	systemPrompt: true,
	turnTimeoutMin: 0, // placeholder: the real default is resolved per loadConfig call (defaultTurnTimeoutMin)
	inactivityTimeoutMin: 5,
	approvals: { gateMode: "auto", mode: "ask" },
	acp: {
		usageEstimate: "estimate",
		sessionTimeoutMs: 20_000,
		sessionRetryOnTimeout: false,
	},
};

const MIN_ACP_SESSION_TIMEOUT_MS = 1_000;
const MAX_ACP_SESSION_TIMEOUT_MS = 300_000;

function parseSessionTimeoutMs(raw: unknown, fallback: number): number {
	if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
	const n = typeof raw === "number" ? raw : Number(String(raw).trim());
	if (!Number.isSafeInteger(n)) return fallback;
	return n >= MIN_ACP_SESSION_TIMEOUT_MS && n <= MAX_ACP_SESSION_TIMEOUT_MS ? n : fallback;
}

/** Hard ceiling for a free-typed turn cap: one day, in minutes. */
export const MAX_TURN_CAP_MIN = 1440;

/** TTY-aware default for the overall turn cap. An interactive user aborts
 *  with Esc and is the better backstop; the wall clock only earns its keep
 *  where nobody can abort (headless runs: one runaway turn also blocks the
 *  drivers' serialized turn queue). */
export function defaultTurnTimeoutMin(): number {
	return process.stdout.isTTY || process.stdin.isTTY ? 0 : 20;
}

/** Explicit cap minutes: 0 keeps (disable), 1..MAX_TURN_CAP_MIN keeps;
 *  garbage, negative, or out-of-range falls back to the caller's default.
 *  Pass Number.NaN as the fallback to detect rejection via isNaN. */
export function parseCapMinutes(raw: string | number | undefined, fallback: number): number {
	if (raw === undefined || String(raw).trim() === "") return fallback;
	const n = typeof raw === "number" ? raw : Number(String(raw).trim());
	if (!Number.isFinite(n)) return fallback;
	if (n === 0) return 0;
	return n >= 1 && n <= MAX_TURN_CAP_MIN ? n : fallback;
}

/** Boolean spellings shared by the AGY_* env grammar and config.json (issue
 *  #23): the /agy UI's on/off vocabulary plus the JSON literals and digits. */
const BOOLISH_TRUE = new Set(["1", "true", "on"]);
const BOOLISH_FALSE = new Set(["0", "false", "off"]);

/** The literal boolean grammar shared by parseBoolish, parseReadOnlyValue,
 *  and saveConfig's pass-through: JSON booleans, the /agy vocabulary as
 *  strings (case/whitespace tolerated), and the JSON numbers 0/1. Returns
 *  undefined for anything outside the grammar. */
function parseBoolishLiteral(raw: unknown): boolean | undefined {
	if (typeof raw === "boolean") return raw;
	if (raw === 0 || raw === 1) return raw === 1;
	if (typeof raw === "string") {
		const v = raw.trim().toLowerCase();
		if (BOOLISH_TRUE.has(v)) return true;
		if (BOOLISH_FALSE.has(v)) return false;
	}
	return undefined;
}

/** Parse a config.json boolean that a hand editor may have written as a
 *  string ("off", "false", "0" - the README and /agy vocabulary) or as the
 *  JSON numbers 0/1. Present but unparseable values fall back to the given
 *  default and warn; the silence is what made issue #23 invisible. */
function parseBoolish(raw: unknown, label: string, fallback: boolean, warnings: string[]): boolean {
	const v = parseBoolishLiteral(raw);
	if (v !== undefined) return v;
	if (raw === undefined || raw === null) return fallback;
	warnings.push(`${label}: ${JSON.stringify(raw)} is not a recognized boolean (true/false, on/off, 1/0); using default ${fallback}`);
	return fallback;
}

/** File-path readOnly parse: the AGY_READONLY env grammar mirrored (issue
 *  #23). Explicit blanks and spelled-out falsities are OFF, every other
 *  present value counts as ON so a typo can never disable the safety knob. */
function parseReadOnlyValue(raw: unknown, warnings: string[]): boolean {
	const failClosed = (rawValue: unknown): boolean => {
		warnings.push(`readOnly: ${JSON.stringify(rawValue)} is not a recognized boolean (true/false, on/off, 1/0); failing closed to true`);
		return true;
	};
	const v = parseBoolishLiteral(raw);
	if (v !== undefined) return v;
	if (typeof raw === "string" && raw === "") return false;
	if (raw === undefined || raw === null) return DEFAULTS.readOnly;
	return failClosed(raw);
}

/** One-line startup/doctor summary for unparseable config values (issue
 *  #23). The toast points at /agy doctor because the per-value detail
 *  (label, raw value, fallback) lives in the parseWarnings row list. */
export function configWarningsMessage(warnings: string[]): string {
	return `config.json: ${warnings.length} unparseable value${warnings.length === 1 ? "" : "s"} fell back to defaults (readOnly fails closed); run /agy doctor for details.`;
}

/** Read the raw config file (no defaults, no env). Shared by loadConfig and
 *  saveConfig so persisted writes can never bake env overrides into the file. */
function readConfigFile(configPath: string): Partial<AgyConfig> {
	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Partial<AgyConfig>;
		}
	} catch {
		/* missing or corrupt  -  fall back to empty */
	}
	return {};
}

/** Strip the retired acp.bin key from the raw config file; returns true when
 *  removed. Raw passthrough on purpose (no defaults merge): users keep their
 *  minimal hand-edited shape instead of gaining the full default set. */
export function removeLegacyAcpBin(configFile: string = configPath()): boolean {
	const file = readConfigFile(configFile) as Record<string, unknown>;
	if (!file.acp || typeof file.acp !== "object" || Array.isArray(file.acp)) return false;
	const acp = file.acp as Record<string, unknown>;
	if (!("bin" in acp)) return false;
	delete acp.bin;
	writeJsonAtomic(configFile, file);
	return true;
}

/** One-time handoff for upgraders from the digest-off default era (issue
 *  #25): pre-flip saves baked digest:false into config.json as a bare
 *  default, and silently keeping it makes mid-session handoffs lose
 *  history. Runs at session_start (loadConfig stays side-effect free);
 *  AGY_DIGEST env wins; the marker key keeps a deliberate post-migration
 *  `/agy digest off` from being flipped back. Returns whether a stale
 *  false was rewritten (caller warns once). */
export function migrateStaleDigestDefault(configFile: string = configPath()): { migrated: boolean } {
	const file = readConfigFile(configFile);
	if (process.env.AGY_DIGEST !== undefined) return { migrated: false };
	if (file.digestMigrated) return { migrated: false };
	if (file.digest !== false) return { migrated: false };
	saveConfig({ digest: true, digestMigrated: true }, configFile);
	return { migrated: true };
}

/** Load config merged over defaults. Env vars override the file when set. */
export function loadConfig(configFile: string = configPath()): AgyConfig {
	let file: Partial<AgyConfig> = readConfigFile(configFile);
	const parseWarnings: string[] = [];

	// Env overrides file (matches the skipPermissions pattern).
	// The naive OR `env === "plan" || file.mode === "plan"` would ignore an
	// explicit AGY_MODE=accept-edits when the file says plan, violating the
	// documented precedence. Check env first.
	// Engine: narrow to the known set; anything else (incl. the pre-1.3.2
	// "sqlite" value) falls back to the default engine, same as an absent key.
	// One absence exception: a config file WITHOUT an engine key belongs to an
	// existing install (saveConfig persists the resolved legacy engine), and
	// the acp default is for new installs only - an existing install keeps
	// the legacy stream-json engine. existsSync is false on EACCES too, which reads as fresh
	// and picks acp; an unreadable config dir is a broken install either way.
	const freshInstall = !fs.existsSync(configFile);
	const engineFallback = freshInstall || file.engine !== undefined ? DEFAULT_ENGINE : "stream-json";
	const engine = narrowEngine(String(process.env.AGY_ENGINE ?? file.engine ?? engineFallback).toLowerCase());

	const mode: AgyMode =
		process.env.AGY_MODE !== undefined
			? process.env.AGY_MODE === "plan"
				? "plan"
				: "accept-edits"
			: file.mode === "plan"
				? "plan"
				: "accept-edits";

	const envPerm = process.env.AGY_SKIP_PERMISSIONS;
	const skipPermissions =
		envPerm !== undefined
			? envPerm === "1" || envPerm.toLowerCase() === "true"
			: parseBoolish(file.skipPermissions, "skipPermissions", DEFAULTS.skipPermissions, parseWarnings);

	const envReadOnly = process.env.AGY_READONLY;
	// Fail-closed parse for a safety knob: empty string means the user
	// explicitly blanked it (off), but ANY other set value that is not a
	// spelled-out falsity counts as ON. " 1", "yes", typos: all refuse.
	const readOnly =
		envReadOnly !== undefined
			? envReadOnly === ""
				? false
				: !["0", "false", "off"].includes(envReadOnly.trim().toLowerCase())
			: parseReadOnlyValue(file.readOnly, parseWarnings);

	const defaultModelRaw =
		process.env.AGY_DEFAULT_MODEL ?? file.defaultModel ?? DEFAULTS.defaultModel;
	const defaultModel =
		typeof defaultModelRaw === "string" ? defaultModelRaw.trim() || DEFAULTS.defaultModel : DEFAULTS.defaultModel;

	const envThink = process.env.AGY_DEFAULT_THINKING;
	const thinkRaw = String(envThink ?? file.defaultThinking ?? DEFAULTS.defaultThinking).toLowerCase();
	const defaultThinking: ThinkingTier =
		thinkRaw === "low" || thinkRaw === "high" || thinkRaw === "xhigh" ? thinkRaw : "medium";

	const askTool = process.env.AGY_ASK_TOOL !== undefined
		? ["1", "true", "on"].includes(process.env.AGY_ASK_TOOL.toLowerCase())
		: parseBoolish(file.askTool, "askTool", DEFAULTS.askTool, parseWarnings);

	const webTools = process.env.AGY_WEB_TOOLS !== undefined
		? ["1", "true", "on"].includes(process.env.AGY_WEB_TOOLS.toLowerCase())
		: parseBoolish(file.webTools, "webTools", DEFAULTS.webTools, parseWarnings);

	const bridgeRaw = String(process.env.AGY_BRIDGE_TOOLS ?? file.bridgeTools ?? DEFAULTS.bridgeTools).toLowerCase();
	const bridgeTools: BridgeTools =
		bridgeRaw === "none" || bridgeRaw === "all" || bridgeRaw === "mcp"
			? bridgeRaw
			: DEFAULTS.bridgeTools;

	// Extra long-window tool names for the bridge escalation (issue #6).
	// Comma-separated in the env; junk entries and junk shapes are dropped,
	// not fatal - loadConfig runs per bridge call and must never throw.
	const longToolsRaw: unknown =
		process.env.AGY_ESCALATE_LONG_TOOLS ?? file.escalateLongTools;
	const longToolsParts: unknown[] = typeof longToolsRaw === "string"
		? longToolsRaw.split(",")
		: Array.isArray(longToolsRaw) ? longToolsRaw : [];
	const escalateLongTools = longToolsParts
		.filter((s): s is string => typeof s === "string")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.slice(0, 32);

	const digest = process.env.AGY_DIGEST !== undefined
		? ["1", "true", "on"].includes(process.env.AGY_DIGEST.toLowerCase())
		: parseBoolish(file.digest, "digest", DEFAULTS.digest, parseWarnings);

	const envSys = process.env.AGY_SYSTEM_PROMPT;
	const systemPrompt = envSys !== undefined
		? ["1", "true", "on"].includes(envSys.toLowerCase())
		: parseBoolish(file.systemPrompt, "systemPrompt", DEFAULTS.systemPrompt, parseWarnings);

	// Turn caps, minutes. Env wins over the file (same pattern as mode).
	const turnTimeoutMin = parseCapMinutes(
		process.env.AGY_TURN_TIMEOUT_MIN ?? file.turnTimeoutMin,
		defaultTurnTimeoutMin(),
	);
	const inactivityTimeoutMin = parseCapMinutes(
		process.env.AGY_INACTIVITY_TIMEOUT_MIN ?? file.inactivityTimeoutMin,
		DEFAULTS.inactivityTimeoutMin,
	);

	// Approval gate (docs/TODO.md 2.5). Unknown values fall back to "auto"
	// so a typo can never silently force the gate on.
	const gateRaw = String(process.env.AGY_APPROVALS ?? file.approvals?.gateMode ?? DEFAULTS.approvals.gateMode).toLowerCase();
	const gateMode: GateMode =
		gateRaw === "shadow" || gateRaw === "dedicated" || gateRaw === "off"
			? gateRaw
			: "auto";
	const askRaw = String(process.env.AGY_APPROVALS_MODE ?? file.approvals?.mode ?? DEFAULTS.approvals.mode).toLowerCase();
	const gateAskMode: GateAskMode =
		askRaw === "allow" || askRaw === "deny"
			? askRaw
			: "ask";

	const fileAcp = (typeof file.acp === "object" && file.acp !== null ? file.acp : {}) as Partial<AcpConfig>;
	// Unknown values fall back to "estimate" (same narrow-parse pattern as
	// gateMode: a typo must never silently change behavior).
	const usageRaw = String(
		process.env.AGY_USAGE_ESTIMATE ?? fileAcp.usageEstimate ?? DEFAULTS.acp.usageEstimate,
	).toLowerCase();
	const usageEstimate: UsageEstimate =
		usageRaw === "direct" || usageRaw === "off" ? usageRaw : "estimate";
	const sessionTimeoutMs = parseSessionTimeoutMs(
		process.env.AGY_ACP_SESSION_TIMEOUT_MS ?? fileAcp.sessionTimeoutMs,
		DEFAULTS.acp.sessionTimeoutMs,
	);
	const envSessionRetry = process.env.AGY_ACP_SESSION_RETRY;
	const sessionRetryOnTimeout = envSessionRetry !== undefined
		? ["1", "true", "on"].includes(envSessionRetry.toLowerCase())
		: parseBoolish(fileAcp.sessionRetryOnTimeout, "acp.sessionRetryOnTimeout", DEFAULTS.acp.sessionRetryOnTimeout, parseWarnings);
	const acp: AcpConfig = { usageEstimate, sessionTimeoutMs, sessionRetryOnTimeout };

	// Custom agent for stream-json turns (--agent). Env wins over the file
	// (same pattern as mode). Normalized (trim/cap/control-strip); an empty
	// result means agy's default agent.
	const agentRaw: unknown = process.env.AGY_AGENT ?? file.agent;
	const agent = normalizeAgyAgentName(typeof agentRaw === "string" ? agentRaw : undefined);

	return {
		engine,
		acp,
		mode,
		readOnly,
		skipPermissions,
		defaultModel,
		defaultThinking,
		askTool,
		webTools,
		bridgeTools,
		escalateLongTools,
		digest,
		systemPrompt,
		turnTimeoutMin,
		inactivityTimeoutMin,
		agent,
		approvals: { gateMode, mode: gateAskMode },
		patchCleanupNotified: file.patchCleanupNotified === true,
		parseWarnings: parseWarnings.length > 0 ? parseWarnings : undefined,
	};
}

/** Narrow a raw engine string to the known set; anything unknown (incl. the
 *  pre-1.3.2 "sqlite" value) falls to the default engine. Shared by
 *  loadConfig's effective-engine resolution and saveConfig's persistence so
 *  the two can never drift. */
function narrowEngine(raw: string): Engine {
	return raw === "acp" || raw === "stream-json" ? raw : DEFAULT_ENGINE;
}

/** Atomically persist a config patch (temp + rename). Merges onto the RAW
 *  FILE values, never loadConfig(): env overrides must not be baked into the
 *  file (AGY_READONLY=1 in the env would otherwise persist readOnly: true to
 *  disk on any unrelated save, outliving the env var). Nested objects are
 *  re-normalized to their known keys: a raw passthrough would resurrect
 *  legacy keys (acp.permissions) that loadConfig normalization drops. */
export type ConfigPatch = Partial<Omit<AgyConfig, "acp" | "parseWarnings">> & { acp?: Partial<AcpConfig> };

export function saveConfig(patch: ConfigPatch, configFile: string = configPath()): AgyConfig {
	const file = readConfigFile(configFile);
	// Null-safe on nested objects: a hand-edited or legacy file can carry
	// "acp": null; loadConfig tolerates it, so must saveConfig. Key presence
	// triggers normalization (a null becomes the default shape, never null).
	const fileAcp: Partial<AcpConfig> = file.acp && typeof file.acp === "object" ? file.acp : {};
	const fileApprovals: Partial<GateConfig> = file.approvals && typeof file.approvals === "object" ? file.approvals : {};
	// Engine persistence follows loadConfig's continuity rule minus env (env
	// must never be baked into the file). A legacy file without an engine key
	// persists "stream-json": the bare DEFAULTS spread below would otherwise
	// write the acp default into an existing install's file on any unrelated
	// save, switching an existing install to ACP on the next start.
	const persistedEngine = patch.engine ?? file.engine
		?? (fs.existsSync(configFile) ? "stream-json" : DEFAULT_ENGINE);
	const { acp: patchAcp, ...restPatch } = patch;
	const mergedAcp: AcpConfig = {
		usageEstimate: patchAcp?.usageEstimate ?? fileAcp.usageEstimate ?? DEFAULTS.acp.usageEstimate,
		sessionTimeoutMs: parseSessionTimeoutMs(
			patchAcp?.sessionTimeoutMs ?? fileAcp.sessionTimeoutMs,
			DEFAULTS.acp.sessionTimeoutMs,
		),
		// Silent literal-grammar pass-through (saveConfig has no warning
		// channel; loadConfig already reports junk at startup / /agy doctor).
		sessionRetryOnTimeout:
			patchAcp?.sessionRetryOnTimeout
				?? parseBoolishLiteral(fileAcp.sessionRetryOnTimeout)
				?? DEFAULTS.acp.sessionRetryOnTimeout,
	};
	// The DEFAULTS 0 is a load-time placeholder (defaultTurnTimeoutMin resolves
	// per TTY state); persisting it would flip absence into "cap disabled"
	// (parseCapMinutes reads 0 as off) on the next load.
	const { turnTimeoutMin: _placeholder, ...defaultsOnDisk } = DEFAULTS;
	// On-disk shape, not AgyConfig: turnTimeoutMin is written only when the
	// file or the patch carries it, and a blanket cast would drop checking
	// for every other key in the literal.
	const next: Omit<AgyConfig, "turnTimeoutMin"> & Partial<Pick<AgyConfig, "turnTimeoutMin">> = {
		...defaultsOnDisk,
		...file,
		...(file.approvals !== undefined
			? { approvals: { gateMode: fileApprovals.gateMode ?? DEFAULTS.approvals.gateMode, mode: fileApprovals.mode ?? DEFAULTS.approvals.mode } }
			: {}),
		...restPatch,
		acp: mergedAcp,
		engine: narrowEngine(String(persistedEngine).toLowerCase()),
		// Computed per load; a raw file spread must never persist it.
		parseWarnings: undefined,
	};
	writeJsonAtomic(configFile, next);
	return next as AgyConfig;
}
