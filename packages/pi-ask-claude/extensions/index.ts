/**
 * AskClaude (standalone) — delegate a self-contained sub-task to the
 * Claude Code CLI. The AskCodex / AskAntigravity delegation pattern,
 * pointed at Claude via `claude -p --output-format stream-json`.
 *
 * One self-contained tool. Spawns `claude -p`, parses the JSONL event
 * stream for structured progress + the final agent message, and returns
 * it. Claude Code runs its OWN tool loop (Read, Edit, Bash, ...) inside
 * the workspace.
 *
 * This is the Claude-Code-specific standalone. It intentionally COEXISTS
 * with elidickinson/pi-claude-bridge only when the bridge's own AskClaude
 * feature is OFF. The bridge ships a richer AskClaude (SDK-backed, shares
 * the pi conversation) that is the more popular choice; to avoid a
 * duplicate-tool conflict this extension self-disables at load time when
 * the bridge is installed, enabled, AND has `askClaude.enabled: true`.
 * See bridgeConflictExists() for the exact detection.
 *
 * Model aliases: friendly names map to `claude --model` aliases
 * ("opus", "sonnet", "haiku", "fable") or full ids ("claude-sonnet-5").
 *
 * Config: ~/.pi/agent/ask-claude.json (global) merged over
 *         .pi/ask-claude.json (project). Editable via /claude.
 *
 * Two modes (agent decides per call):
 *   - omit sessionId    -> one-shot, Claude starts a fresh session
 *   - pass sessionId     -> resume that Claude session (full context)
 * The prompt is delivered via STDIN (not a positional) because
 * `--allowedTools` / `--tools` are variadic flags that would otherwise
 * swallow a positional prompt. Fresh runs let claude assign the session
 * id and capture it from the `system/init` event; continuation uses
 * `--resume <id>`.
 *
 * Env:  CLAUDE_BIN (binary path), CLAUDE_EXTRA_ARGS (extra args; the value
 *       is parsed with a shell-like splitter so quoted args with spaces
 *       work).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	buildSessionContext,
	getAgentDir,
	getSettingsListTheme,
	keyHint,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, contentText } from "@earendil-works/pi-ai";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	BackgroundRunRegistry,
	backgroundFlagText,
	buildClaudeArgs,
	cleanClaudeStderr,
	CLAUDE_SESSION_ID_RE,
	configPaths,
	consumeClaudeEvent,
	createStopHandler,
	createWakeSender,
	emptyClaudeEventState,
	loadLayeredRaw,
	RunSpawnError,
	runProcess,
	saveLayeredConfig,
	summarizePrompt,
	tryReadJson,
	type BuildArgsOptions,
	type ClaudeStreamEvent,
	type SaveResult,
} from "@estebanforge/pi-ask-shared";

// --- Constants -------------------------------------------------------------

const DEFAULT_TIMEOUT_MIN = 10;
const STATUS_INTERVAL_MS = 1000;
const DISCOVERY_TIMEOUT_MS = 8_000;

// renderCall / renderResult preview limits (match pi-claude-bridge).
const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

const DEFAULT_MODEL = "sonnet";
const DEFAULT_MODE = "full";
const DEFAULT_EFFORT = "default"; // "default" = omit --effort (Claude's own default)

const BRIDGE_PACKAGE_ID = "pi-claude-bridge";
const BRIDGE_CONFIG_NAME = "claude-bridge.json";

// Claude session ids live in the shared peer adapter (CLAUDE_SESSION_ID_RE):
// UUID-anchored so a leading-dash value can never misbind on claude's parser.

const CLAUDE_DESCRIPTION = `Delegate a self-contained sub-task to Claude Code. This is the standalone Claude-Code-specific delegation tool (it shells out to \`claude -p\`). It is distinct from the AskClaude tool provided by pi-claude-bridge: that one shares the pi conversation via the Agent SDK; this one runs an isolated Claude Code subprocess. When the user says "ask claude", "ask claude code", or otherwise refers to delegating to Claude Code, call THIS tool. Claude runs its OWN tool loop (Read, Grep, Edit, Bash, ...) inside the workspace, then returns its final answer. Use for a second opinion, code review, architecture questions, debugging theories, or to autonomously handle a task you do not need to drive step-by-step. Provide a complete, self-contained task description; Claude will not see this conversation unless you resume a prior session.

TWO MODES (you choose):
- **One-shot (isolated)**: omit sessionId. Claude starts a fresh session with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the sessionId returned in the PREVIOUS call's details (details.sessionId). Claude resumes that session with full context intact — use for follow-ups, multi-turn refinement, or when the user says "ask claude to follow up / continue / now do X based on what you just did". Thread the id from each result into the next call.

PERMISSION MODES (the \`mode\` param):
- **full** (default): full tool access. Reads, edits, and runs bash without permission prompts (pi philosophy: pi has none either). Skips per-action permission checks.
- **read**: research / analysis / review with file access but no mutations. Restricts Claude to read-only tools (Read/Grep/Glob/LS/WebSearch/WebFetch).
- **none**: general knowledge only, no file or tool access at all.`;

// --- Types -----------------------------------------------------------------

type Effort = "default" | "low" | "medium" | "high" | "xhigh";
type PermissionMode = "read" | "none" | "full";

interface Config {
	defaultModel: string;
	defaultMode: PermissionMode;
	defaultEffort: Effort;
	allowFullMode: boolean;
}

// --- Config ----------------------------------------------------------------

/** Layered config paths: global resolves via pi's getAgentDir() (rebranded
 *  distro safe); project is <cwd>/.pi. Resolution stays extension-local by
 *  design — codex/antigravity hardcode ~/.pi/agent. */
function configPathsFor(cwd: string) {
	return configPaths({ globalDir: getAgentDir(), projectDir: cwd, fileName: "ask-claude.json" });
}

const EFFORT_VALUES: Effort[] = ["default", "low", "medium", "high", "xhigh"];
const MODE_VALUES: PermissionMode[] = ["read", "none", "full"];

function isEffort(v: unknown): v is Effort {
	return typeof v === "string" && (EFFORT_VALUES as string[]).includes(v);
}
function isPermissionMode(v: unknown): v is PermissionMode {
	return typeof v === "string" && (MODE_VALUES as string[]).includes(v);
}

export function loadConfig(cwd: string): Config {
	const { merged } = loadLayeredRaw(configPathsFor(cwd));

	const effortRaw = String(merged.defaultEffort ?? DEFAULT_EFFORT).toLowerCase();
	const effort: Effort = isEffort(effortRaw) ? effortRaw : DEFAULT_EFFORT;

	const modeRaw = String(merged.defaultMode ?? DEFAULT_MODE).toLowerCase();
	const mode: PermissionMode = isPermissionMode(modeRaw) ? modeRaw : DEFAULT_MODE;

	// A model id never starts with '-'; if a config value does (corrupted or
	// hostile edit), fall back to the default rather than let it reach argv.
	const modelRaw = String(merged.defaultModel ?? DEFAULT_MODEL).trim();
	const defaultModel = modelRaw && !modelRaw.startsWith("-") ? modelRaw : DEFAULT_MODEL;

	return {
		defaultModel,
		defaultMode: mode,
		defaultEffort: effort,
		allowFullMode: merged.allowFullMode !== false,
	};
}

/** Persist a config patch via the shared all-or-nothing router: if any
 *  patched key is already project-defined, the whole patch goes to the
 *  project file (it shadows global on load). Atomic write inside. */
function saveConfig(cwd: string, patch: Partial<Config>): SaveResult {
	return saveLayeredConfig(configPathsFor(cwd), patch as Record<string, unknown>);
}

// --- Conflict guard: detect pi-claude-bridge's own AskClaude ---------------

export interface ConflictResult {
	conflict: boolean;
	reason: string;
}

/** True if `src` names the pi-claude-bridge package in either install form:
 *  npm ("npm:pi-claude-bridge") or git ("git:github.com/elidickinson/pi-claude-bridge").
 *  Matches the package id as a whole token so "not-pi-claude-bridge" never hits. */
export function isClaudeBridgeSource(src: string): boolean {
	return new RegExp(`(^|[:/])${escapeRegex(BRIDGE_PACKAGE_ID)}$`).test(src);
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A `packages` entry from settings.json is either a plain source string
 *  ("npm:X" — enabled, loads all default extensions) or an object
 *  { source, extensions?: string[] }. `extensions: []` means the package is
 *  installed but every extension is disabled; a missing `extensions` key
 *  means default (enabled); a non-empty array enables only those paths.
 *  Returns whether the bridge's extension would actually load here. */
export function bridgePackageEnabled(entry: unknown): boolean {
	if (typeof entry === "string") return isClaudeBridgeSource(entry);
	if (entry && typeof entry === "object") {
		const e = entry as { source?: unknown; extensions?: unknown };
		if (typeof e.source === "string" && isClaudeBridgeSource(e.source)) {
			// No `extensions` key, or a non-empty array, => enabled. Only an
			// explicit empty array disables every extension the package ships.
			return !Array.isArray(e.extensions) || e.extensions.length > 0;
		}
	}
	return false;
}

/** Replicate the bridge's own config merge (src/config.ts loadConfig):
 *  project `.pi/claude-bridge.json` askClaude shadows global. */
export function bridgeAskClaudeEnabled(agentDir: string, cwd: string): boolean {
	const global = tryReadJson(path.join(agentDir, BRIDGE_CONFIG_NAME));
	const project = tryReadJson(path.join(cwd, CONFIG_DIR_NAME, BRIDGE_CONFIG_NAME));
	const g = (global.askClaude ?? {}) as Record<string, unknown>;
	const p = (project.askClaude ?? {}) as Record<string, unknown>;
	const merged = { ...g, ...p };
	// Match the bridge's ACTUAL gate: `if (askConf?.enabled)` is truthy, not
	// strict-equal (verified pi-claude-bridge src/index.ts:2092). So enabled:1
	// / "true" / "yes" all make the bridge register; treat them as a conflict
	// too, else both tools register at once.
	return Boolean(merged.enabled);
}

/** Decide whether this extension must stand down to avoid clashing with
 *  pi-claude-bridge's own (richer, SDK-backed) AskClaude tool. Reads the
 *  same inputs pi and the bridge read, so the decision matches what the
 *  bridge itself will register. Fail-open: any read/parse problem on the
 *  side that would gate us resolves to "no conflict", so a broken
 *  settings.json never silently disables the standalone. */
export function bridgeConflictExists(agentDir: string, cwd: string): ConflictResult {
	const settingsPath = path.join(agentDir, "settings.json");
	const settings = tryReadJson(settingsPath);
	const packages = (settings as { packages?: unknown }).packages;
	if (!Array.isArray(packages)) return { conflict: false, reason: "settings.json has no packages list" };

	const bridgeEntry = packages.find((p) => bridgePackageEnabled(p));
	if (!bridgeEntry) return { conflict: false, reason: `${BRIDGE_PACKAGE_ID} not installed/enabled in settings.json packages` };

	if (!bridgeAskClaudeEnabled(agentDir, cwd)) {
		return { conflict: false, reason: `${BRIDGE_PACKAGE_ID} installed+enabled, but askClaude.enabled is not true (its AskClaude tool stays opt-in/off)` };
	}

	return {
		conflict: true,
		reason: `${BRIDGE_PACKAGE_ID} is installed, enabled, and has askClaude.enabled=true — its AskClaude tool is active. Standing down to avoid a duplicate-tool conflict.`,
	};
}

// --- claude process helpers ------------------------------------------------
// buildClaudeArgs, the stream-json event grammar (consumeClaudeEvent), the
// status-line vocabulary, and stderr noise filtering live in pi-ask-shared
// (peers/claude.ts) so pi-unblock consults reuse the exact same contract.

function resolveClaude(): string {
	return process.env.CLAUDE_BIN || "claude";
}

/** Shell-like argument splitter for CLAUDE_EXTRA_ARGS: respects "..." and
 *  '...' quoted segments so a value with spaces stays one arg. */
function splitArgs(raw: string): string[] {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return [];
	const parts: string[] = [];
	const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(trimmed)) !== null) {
		parts.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return parts;
}

function extraArgs(): string[] {
	const raw = process.env.CLAUDE_EXTRA_ARGS;
	return raw ? splitArgs(raw) : [];
}

/** Best-effort version check: `claude --version` exits 0 and prints a
 *  version string. Used to fail fast with a clear message instead of an
 *  opaque spawn error inside the tool call. */
async function claudeAvailable(binary: string): Promise<boolean> {
	try {
		const out = await new Promise<string>((resolve, reject) => {
			const proc = spawn(binary, ["--version"], {
				stdio: ["ignore", "pipe", "ignore"],
				shell: false,
			});
			proc.stdout?.setEncoding("utf8");
			let out = "";
			let done = false;
			const finish = (v: string) => {
				if (done) return;
				done = true;
				clearTimeout(watchdog);
				resolve(v);
			};
			proc.stdout?.on("data", (d: string) => (out += d));
			proc.on("error", (err) => {
				clearTimeout(watchdog);
				reject(err);
			});
			proc.on("close", (code) => finish(code === 0 ? out : ""));
			const watchdog = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
				finish("");
			}, DISCOVERY_TIMEOUT_MS);
		});
		return /claude/i.test(out);
	} catch {
		return false;
	}
}

// --- Argv + stream grammar: shared peer adapter ----------------------------
// See peers/claude.ts in pi-ask-shared.

// --- Full-context export (opt-in includeContext) --------------------------
// NOTE: this helper is intentionally duplicated per pi-ask-* package (each is
// self-contained). Duck-typed over role/content so it tolerates AgentMessage's
// union + custom message types without importing fragile internal generics.

// Tool-call inputs and tool-result bodies are clamped so the exported
// transcript stays reviewable; the agent can re-read any source file by path.
// User/assistant prose is kept in full (that IS the conversation).
const CONTEXT_BLOCK_MAX_CHARS = 2000;

function clampBlock(text: unknown, limit = CONTEXT_BLOCK_MAX_CHARS): string {
	const t = String(text ?? "");
	return t.length > limit ? `${t.slice(0, limit)}\n…[truncated, ${t.length - limit} more chars]` : t;
}

/** Render resolved pi AgentMessages to a readable markdown transcript.
 *  Pure: no IO. Caller writes the returned string to a temp file. */
export function renderAgentMessagesMarkdown(messages: readonly unknown[]): string {
	const lines: string[] = [
		"# Pi conversation context",
		"",
		`_Exported for full-context delegation. ${messages.length} message(s)._`,
		"",
	];
	for (const raw of messages) {
		const m = raw as { role?: string; content?: unknown };
		const role = m.role ?? "message";
		const content = m.content;
		if (role === "assistant") {
			const blocks = (Array.isArray(content) ? content : []) as ReadonlyArray<{
				type: string;
				text?: string;
				name?: string;
				input?: unknown;
			}>;
			const text = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			if (text.trim()) lines.push("## Assistant", "", text, "");
			for (const b of blocks) {
				if (b.type === "toolCall" || b.type === "tool_use") {
					const input = clampBlock(
						typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? ""),
						500,
					);
					lines.push(`> tool call: ${b.name ?? "(unknown)"}(${input})`, "");
				}
			}
		} else if (role === "toolResult" || role === "tool_result" || role === "tool") {
			const text = contentText(content as any);
			if (text.trim()) lines.push("## Tool result", "", clampBlock(text), "");
		} else {
			const text = contentText(content as any);
			if (text.trim()) lines.push(`## ${role}`, "", clampBlock(text), "");
		}
	}
	return lines.join("\n");
}

/** Centralized scratch dir for full-context exports, following the
 *  ~/.pi/extensions-data/<author>/<extension>/ convention (see pi-token-cost-ledger).
 *  Derived from getAgentDir() so rebranded distros resolve correctly. */
function askContextDir(): string {
	return path.join(path.dirname(getAgentDir()), "extensions-data", "estebanforge", "pi-ask-claude");
}

// --- Extension -------------------------------------------------------------

interface ClaudeDetails {
	model: string | null;
	mode: PermissionMode;
	effort: Effort;
	sessionId: string | null;
	includeContext: boolean;
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	/** True when the `result` stream event carried is_error (error_during_execution, max_turns, refusal). Distinct from exitCode: claude can exit 0 while reporting is_error. */
	resultIsError: boolean;
	resultSubtype: string | null;
	durationMs: number;
	usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null;
	costUsd: number | null;
	turns: number | null;
	stderr: string;
}

function emptyDetails(model: string | null, mode: PermissionMode, effort: Effort): ClaudeDetails {
	return {
		model,
		mode,
		effort,
		sessionId: null,
		includeContext: false,
		exitCode: 0,
		aborted: false,
		timedOut: false,
		resultIsError: false,
		resultSubtype: null,
		durationMs: 0,
		usage: null,
		costUsd: null,
		turns: null,
		stderr: "",
	};
}


// --- Background-mode plumbing ----------------------------------------------
// Shared shape for both call styles: blocking awaits it, background lets it
// run detached and pushes the outcome through the wake sender on close.
// Process mechanics (spawn/kill-tree/watchdog/settle-on-close) live in the
// shared runProcess; this layer owns the claude stream contract + status.

/** Spawn failure (binary vanished between the availability check and spawn). Carries whatever stderr accumulated. */
class ClaudeSpawnError extends Error {
	readonly stderrClean: string;
	constructor(message: string, stderrClean: string) {
		super(message);
		this.stderrClean = stderrClean;
	}
}

interface ProcessRunOptions {
	binary: string;
	args: string[];
	prompt: string;
	workdir: string;
	timeoutMin: number;
	startAt: number;
	/** Mutated in place: sessionId, usage, resultSubtype, cost, turns. */
	details: ClaudeDetails;
	/** Blocking passes pi's per-run signal; background passes none on purpose: a later Esc must not kill a detached run. */
	signal?: AbortSignal;
	/** Blocking only: throttled progress partials. */
	onPartial?: (text: string) => void;
	/** Background only: hands over the tree-kill switch as soon as the child exists. */
	onSpawn?: (kill: () => void) => void;
}

interface ProcessRunOutcome {
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	/** Final result event text, falling back to accumulated assistant text. Already trimmed. */
	answerText: string;
	stderrClean: string;
}

/** Tool-result shape this extension returns; keeps the background helper's literals narrow. */
interface AskToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: ClaudeDetails;
}

/**
 * Spawns claude -p via the shared runProcess, consumes the stream-json
 * events through the shared peer adapter, and resolves when the process
 * tree closes. Process mechanics (kill-tree, watchdog, abort, settle-on-
 * close) are runProcess's; this layer owns only the claude stream contract
 * and the throttled status partials.
 */
async function runClaudeProcess(opts: ProcessRunOptions): Promise<ProcessRunOutcome> {
	const { binary, args, prompt, workdir, timeoutMin, startAt, details, signal, onPartial, onSpawn } = opts;
	const st = emptyClaudeEventState();

	const statusInterval = onPartial
		? setInterval(() => {
				const elapsed = Math.floor((Date.now() - startAt) / 1000);
				const tail = st.statusLines.slice(-3).join("\n");
				const text = tail ? `(running ${elapsed}s)\n${tail}` : `(running ${elapsed}s)`;
				onPartial(text);
			}, STATUS_INTERVAL_MS)
		: null;

	try {
		let outcome;
		try {
			outcome = await runProcess({
				binary,
				args,
				stdin: prompt,
				cwd: workdir,
				timeoutMs: timeoutMin * 60_000,
				signal,
				onLine: (line) => {
					const trimmed = line.trim();
					if (!trimmed) return;
					try {
						consumeClaudeEvent(JSON.parse(trimmed) as ClaudeStreamEvent, st);
					} catch {
						return;
					}
					// Mirror the accumulator onto details so partial progress
					// keeps showing live sessionId/usage. The continuation id
					// (preset in details) is sticky; init only fills a blank.
					if (!details.sessionId && st.sessionId) details.sessionId = st.sessionId;
					details.resultIsError = st.resultIsError;
					details.resultSubtype = st.resultSubtype;
					details.usage = st.usage;
					details.costUsd = st.costUsd;
					details.turns = st.turns;
				},
				onSpawn,
			});
		} catch (err) {
			// Preserve the extension's spawn-error contract (cleaned stderr).
			if (err instanceof RunSpawnError) throw new ClaudeSpawnError(err.message, cleanClaudeStderr(err.stderr));
			throw err;
		}
		return {
			exitCode: outcome.exitCode,
			aborted: outcome.aborted,
			timedOut: outcome.timedOut,
			answerText: (st.finalMessage || st.assistantText).trim(),
			stderrClean: cleanClaudeStderr(outcome.stderr),
		};
	} finally {
		if (statusInterval) clearInterval(statusInterval);
	}
}

/**
 * Builds the user/model-facing answer text for every terminal outcome.
 * Pure: same inputs always render the same string, so background wakes and
 * blocking results stay word-identical for the same run.
 */
function shapeFinalText(details: ClaudeDetails, outcome: ProcessRunOutcome, timeoutMin: number): string {
	const text = outcome.answerText;
	// claude can exit 0 while the result event carries is_error
	// (error_during_execution, max_turns, refusal). Surface it so a
	// failed run is never reported to the orchestrator as a clean answer.
	const isErrorNote =
		details.resultIsError && outcome.exitCode === 0
			? `\n\n[claude reported an error${details.resultSubtype ? `: ${details.resultSubtype}` : ""} — the answer above may be incomplete or unreliable]`
			: "";

	if (outcome.aborted) {
		return text ? `claude was aborted. Partial answer:\n\n${text}` : "claude was aborted before producing output.";
	}
	if (outcome.timedOut) {
		const note = `claude exceeded the ${timeoutMin}m timeout and was killed`;
		return text ? `${text}\n\n[${note}]` : note;
	}
	if (outcome.exitCode !== 0) {
		const note = details.stderr.trim()
			? `claude exited with status ${outcome.exitCode}: ${details.stderr.trim()}`
			: `claude exited with status ${outcome.exitCode}`;
		return text ? `${text}\n\n[${note}]` : note;
	}

	const footer = details.sessionId
		? `\n\n[claude sessionId: ${details.sessionId} — pass as sessionId to continue this conversation]`
		: "";
	const usageSuffix = details.usage
		? `\n[tokens: ${details.usage.inputTokens} in / ${details.usage.outputTokens} out${details.usage.cacheReadTokens > 0 ? ` / ${details.usage.cacheReadTokens} cache read` : ""}${details.usage.cacheWriteTokens > 0 ? ` / ${details.usage.cacheWriteTokens} cache write` : ""}]`
		: "";
	const costSuffix =
		details.costUsd != null && details.costUsd > 0
			? ` [cost: $${details.costUsd.toFixed(4)}${details.turns != null ? `, ${details.turns} turn(s)` : ""}]`
			: details.turns != null
				? ` [${details.turns} turn(s)]`
				: "";

	return (text || "(claude returned no message)") + isErrorNote + footer + usageSuffix + costSuffix;
}

export default async function (pi: ExtensionAPI) {
	const binary = resolveClaude();
	const available = await claudeAvailable(binary).catch(() => false);

	const cwd = process.cwd();
	const conflict = bridgeConflictExists(getAgentDir(), cwd);

	if (conflict.conflict) {
		// Stand down: register NOTHING that could duplicate the bridge's
		// AskClaude tool. Keep a /claude command so the user can see why.
		console.warn(`[pi-ask-claude] ${conflict.reason}`);
		pi.registerCommand("claude", {
			description: "AskClaude (standalone): disabled because pi-claude-bridge provides AskClaude. Usage: /claude",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					[
						"AskClaude (standalone) is not registered.",
						"",
						conflict.reason,
						"",
						"To use THIS standalone instead of the bridge's AskClaude:",
						"  set askClaude.enabled=false in ~/.pi/agent/claude-bridge.json",
						"  (or uninstall npm:pi-claude-bridge), then restart pi.",
					].join("\n"),
					"info",
				);
			},
		});
		return;
	}

	// --- Background-run state (one set per extension load) -------------------
	// Pi wipes module state on /new, /resume, /fork and /reload: an in-flight
	// background run is killed and its result is never delivered. Accepted
	// trade-off, documented in the README.
	const registry = new BackgroundRunRegistry({ toolName: "ask-claude" });
	const kills = new Map<string, () => void>();
	// Staged-artifact cleanup (contextFile), keyed by run: the session_shutdown
	// backstop runs these when a hard exit would skip the close-path finally.
	const cleanups = new Map<string, () => void>();
	const sendWake = createWakeSender(pi, {
		customType: "ask-claude-result",
		isDisposed: () => registry.isDisposed(),
	});
	const stopBackground = createStopHandler(registry, {
		kill: (run) => kills.get(run.runId)?.(),
		onStopped: (run) =>
			sendWake({
				toolLabel: "Claude Code",
				runId: run.runId,
				ok: false,
				elapsedS: Math.round((Date.now() - run.startedAt) / 1000),
				error: "stopped via /claude-stop",
			}),
	});
	pi.on("session_shutdown", () => {
		// Latch first so close-handler wakes stay silent, then kill children,
		// then sweep staged artifacts (hard exit would skip the close-path cleanup).
		for (const run of registry.dispose()) kills.get(run.runId)?.();
		for (const fn of cleanups.values()) fn();
		cleanups.clear();
		kills.clear();
	});

	// --- /claude: view / change defaults -----------------------------------

	const MODEL_OPTIONS = ["sonnet", "opus", "haiku", "fable"];
	const MODE_OPTIONS: PermissionMode[] = MODE_VALUES;
	const EFFORT_OPTIONS: Effort[] = EFFORT_VALUES;

	pi.registerCommand("claude", {
		description: "AskClaude config: show status, or open the model/mode/effort picker. Usage: /claude",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd ?? process.cwd());

			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					[
						`AskClaude config`,
						`  claude available:  ${available ? "yes" : "NO (check PATH / CLAUDE_BIN)"}`,
						`  defaultModel:      ${config.defaultModel}`,
						`  defaultMode:       ${config.defaultMode}`,
						`  defaultEffort:     ${config.defaultEffort}`,
						`  allowFullMode:     ${config.allowFullMode}`,
						`  bridge conflict:   ${conflict.conflict ? "yes (stand-down)" : "no"}`,
						``,
						`Edit: ~/.pi/agent/ask-claude.json`,
					].join("\n"),
					"info",
				);
				return;
			}

			const items: SettingItem[] = [
				{
					id: "defaultModel",
					label: "Default model",
					description:
						"Claude Code model alias or full id used when the tool call omits `model`. Aliases: sonnet, opus, haiku, fable. Full ids (e.g. claude-sonnet-5) pass through verbatim.",
					currentValue: config.defaultModel,
					values: MODEL_OPTIONS,
				},
				{
					id: "defaultMode",
					label: "Default permission mode",
					description:
						"full (default): edits + bash, no permission prompts. read: file access, no mutations. none: general knowledge only, no tools. Gated by allowFullMode.",
					currentValue: config.defaultMode,
					values: MODE_OPTIONS,
				},
				{
					id: "defaultEffort",
					label: "Default effort (thinking)",
					description:
						"Mapped to `claude --effort`. 'default' omits the flag (Claude's own default); higher = more thorough and slower.",
					currentValue: config.defaultEffort,
					values: EFFORT_OPTIONS,
				},
				{
					id: "allowFullMode",
					label: "Allow full mode",
					description:
						"When off, mode=full is refused. full lets Claude edit files and run bash without feedback to pi.",
					currentValue: config.allowFullMode ? "on" : "off",
					values: ["on", "off"],
				},
			];

			const pending: Partial<Config> = {};

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(
					new Text(theme.fg("accent", theme.bold("AskClaude defaults")), 1, 1),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 4, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						if (id === "defaultModel") {
							pending.defaultModel = newValue;
						} else if (id === "defaultMode") {
							if (isPermissionMode(newValue)) pending.defaultMode = newValue;
						} else if (id === "defaultEffort") {
							if (isEffort(newValue)) pending.defaultEffort = newValue;
						} else if (id === "allowFullMode") {
							pending.allowFullMode = newValue === "on";
						}
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});

			if (Object.keys(pending).length === 0) return;

			try {
				const result = saveConfig(ctx.cwd ?? process.cwd(), pending);
				const changed = Object.entries(pending)
					.map(([k, v]) => `${k}=${v}`)
					.join(", ");
				const where = result.routedToProject
					? "(written to project .pi/ask-claude.json — it shadows global)"
					: "";
				ctx.ui.notify(`Saved: ${changed}${where ? ` ${where}` : ""}`, "info");
			} catch (err) {
				ctx.ui.notify(
					`Failed to save config: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// --- Tool registration -------------------------------------------------

	const modelParam = Type.Optional(
		Type.String({
			description:
				"Claude model alias or full id. Aliases: 'sonnet', 'opus', 'haiku', 'fable'. Full ids (e.g. 'claude-sonnet-5') pass through verbatim. Omit for the configured default.",
		}),
	);

	pi.registerTool({
		name: "AskClaude",
		label: "Ask Claude Code",
		description: CLAUDE_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained task for Claude Code. Include all context Claude needs; it cannot see this conversation (unless you pass a sessionId to resume).",
			}),
			cwd: Type.Optional(
				Type.String({
					description: "Absolute workspace path Claude runs in. Defaults to the current project root.",
				}),
			),
			model: modelParam,
			mode: Type.Optional(
				StringEnum(MODE_VALUES, {
					description:
						"Permission mode: 'full' (default, full tool access: edits + bash without permission prompts), 'read' (research/analysis with file access, no mutations), 'none' (general knowledge only, no tools). Overrides the configured default.",
				}),
			),
			thinking: Type.Optional(
				StringEnum(EFFORT_VALUES, {
					description:
						"Effort / thinking level, mapped to `claude --effort`: 'default' (omit the flag), 'low', 'medium', 'high', 'xhigh'. Higher = more thorough and slower. Overrides the configured default.",
				}),
			),
			sessionId: Type.Optional(
				Type.String({
					description:
						"Omit for a one-shot (Claude starts a fresh session). To CONTINUE a previous Claude session with its context intact, pass the sessionId returned in that call's details. Claude resumes that session.",
				}),
			),
			includeContext: Type.Optional(
				Type.Boolean({
					description:
						"When true, export the current pi conversation (resolved, as markdown) to a temp file inside the workspace and tell Claude to read it first. Default false (isolated one-shot). Opt in only when the user explicitly wants Claude to see the full conversation; it costs Claude tokens to read.",
				}),
			),
			systemPrompt: Type.Optional(
				Type.String({
					description: "Replace Claude's default system prompt entirely (--system-prompt). Rarely needed.",
				}),
			),
			appendSystemPrompt: Type.Optional(
				Type.String({
					description: "Append to Claude's default system prompt (--append-system-prompt).",
				}),
			),
			timeoutMinutes: Type.Optional(
				Type.Number({
					description: `Hard cap on the Claude run in minutes. Default ${DEFAULT_TIMEOUT_MIN}.`,
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: backgroundFlagText("sessionId"),
					default: false,
				}),
			),
		}),
		renderCall(args, theme, context) {
			// Show RESOLVED model/thinking/mode (config defaults applied) so the
			// row identifies what will actually run, not just explicit args.
			const cfg = loadConfig(context.cwd);
			const model = (args.model as string | undefined)?.trim() || cfg.defaultModel;
			const effort: Effort = isEffort(args.thinking) ? args.thinking : cfg.defaultEffort;
			const mode: PermissionMode = isPermissionMode(args.mode) ? args.mode : cfg.defaultMode;
		const isContinue =
			typeof args.sessionId === "string" && CLAUDE_SESSION_ID_RE.test(args.sessionId);

			const tags: string[] = [`model=${model}`, `thinking=${effort}`];
			if (mode !== cfg.defaultMode) tags.push(`mode=${mode}`);
			if (isContinue) tags.push("continue");
			if (args.includeContext) tags.push("context=full");
			if (args.background) tags.push("bg");

			let text = theme.fg("mdLink", theme.bold("AskClaude "));
			text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;

			const prompt = String(args.prompt ?? "");
			const truncated = prompt.length > PREVIEW_MAX_CHARS ? prompt.slice(0, PREVIEW_MAX_CHARS) : prompt;
			const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
			text += theme.fg("muted", `"${lines.join("\n")}"`);
			if (prompt.length > PREVIEW_MAX_CHARS || prompt.split("\n").length > PREVIEW_MAX_LINES) {
				text += theme.fg("dim", " …");
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const d = result.details as ClaudeDetails | undefined;
			if (isPartial) {
				const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
				return new Text(theme.fg("mdLink", "◉ AskClaude ") + theme.fg("muted", status), 0, 0);
			}

			const body = result.content[0]?.type === "text" ? result.content[0].text : "";
			const errored = !!d?.resultIsError || d?.exitCode !== 0 || !!d?.aborted || !!d?.timedOut;

			let text = errored
				? theme.fg("error", "✗ AskClaude error")
				: theme.fg("mdLink", "✓ AskClaude");

			const rTags: string[] = [];
			if (d?.model) rTags.push(`model=${d.model}`);
			if (d?.effort) rTags.push(`thinking=${d.effort}`);
			if (rTags.length) text += ` ${theme.fg("accent", `[${rTags.join(", ")}]`)}`;
			if (d?.durationMs) text += ` ${theme.fg("dim", `${(d.durationMs / 1000).toFixed(1)}s`)}`;
			if (d?.mode && d.mode !== DEFAULT_MODE) text += ` ${theme.fg("muted", d.mode)}`;
			if (d?.includeContext) text += ` ${theme.fg("muted", "context=full")}`;

			if (expanded) {
				if (body) text += `\n${theme.fg("toolOutput", body)}`;
			} else {
				const truncated = body.length > PREVIEW_MAX_CHARS ? body.slice(0, PREVIEW_MAX_CHARS) : body;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
				if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) {
					text += `\n${theme.fg("dim", `… (${keyHint("app.tools.expand", "to expand")})`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Circular-delegation guard: if the active provider is the
			// claude-bridge provider, the orchestrator is ALREADY running
			// through Claude Code — delegating again is redundant.
			if (ctx.model?.baseUrl === "claude-bridge" || ctx.model?.provider === "claude-bridge") {
				return {
					content: [
						{
							type: "text",
							text: "Error: AskClaude (standalone) cannot be used when the active provider is claude-bridge — you're already running through Claude Code. Use the bridge's AskClaude tool or switch providers.",
						},
					],
					details: { ...emptyDetails(null, DEFAULT_MODE, DEFAULT_EFFORT), stderr: "circular delegation blocked" },
				};
			}

			// Re-check the bridge conflict at call time too. The load-time
			// check could miss a change made since this process started
			// (e.g. the user enabled askClaude without restarting). If the
			// bridge's AskClaude is now live, refuse rather than clash.
			const liveConflict = bridgeConflictExists(getAgentDir(), ctx.cwd ?? process.cwd());
			if (liveConflict.conflict) {
				return {
					content: [
						{
							type: "text",
							text: `AskClaude (standalone) is not available: ${liveConflict.reason}`,
						},
					],
					details: { ...emptyDetails(null, DEFAULT_MODE, DEFAULT_EFFORT), stderr: "bridge conflict" },
				};
			}

			if (!available) {
				return {
					content: [
						{
							type: "text",
							text: `Error: claude CLI not found at "${binary}". Install Claude Code or set CLAUDE_BIN to its path (restart pi afterward — the path is checked once at startup).`,
						},
					],
					details: emptyDetails(null, DEFAULT_MODE, DEFAULT_EFFORT),
				};
			}

			const config = loadConfig(ctx.cwd ?? process.cwd());
			const requestedModel = (params.model as string | undefined) ?? config.defaultModel;
			if (typeof params.model === "string" && params.model.trim().startsWith("-")) {
				return {
					content: [
						{
							type: "text",
							text: `model value "${params.model}" starts with "-" — not a valid model id. Use an alias (sonnet/opus/haiku/fable) or a full id (e.g. claude-sonnet-5).`,
						},
					],
					details: emptyDetails(requestedModel, DEFAULT_MODE, DEFAULT_EFFORT),
				};
			}

			const mode = isPermissionMode(params.mode) ? params.mode : config.defaultMode;
			if (mode === "full" && !config.allowFullMode) {
				return {
					content: [
						{
							type: "text",
							text: "mode 'full' is disabled by config (allowFullMode=false). Use 'read' or 'none', or set allowFullMode=true in ~/.pi/agent/ask-claude.json.",
						},
					],
					details: emptyDetails(requestedModel, mode, DEFAULT_EFFORT),
				};
			}
			const effort = isEffort(params.thinking) ? params.thinking : config.defaultEffort;

			const workdir = params.cwd || ctx.cwd || process.cwd();

			try {
				const stat = fs.statSync(workdir);
				if (!stat.isDirectory()) {
					return {
						content: [{ type: "text", text: `cwd is not a directory: ${workdir}` }],
						details: emptyDetails(requestedModel, mode, effort),
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `cwd does not exist: ${workdir}` }],
					details: emptyDetails(requestedModel, mode, effort),
				};
			}

			const timeoutMin = params.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN;

			const rawSessionId = params.sessionId;
			const isContinuation =
				typeof rawSessionId === "string" && rawSessionId.length > 0 && CLAUDE_SESSION_ID_RE.test(rawSessionId);

			const args = buildClaudeArgs({
				model: requestedModel,
				effort,
				mode,
				allowFullMode: config.allowFullMode,
				systemPrompt: params.systemPrompt,
				appendSystemPrompt: params.appendSystemPrompt,
				sessionId: isContinuation ? (rawSessionId as string) : undefined,
				extraArgs: extraArgs(),
			});

			// Opt-in full-context export: render the resolved pi conversation to a
			// temp markdown file inside the workspace and prepend a pointer to the
			// prompt. Isolated (includeContext omitted/false) stays the default.
			let effectivePrompt = params.prompt;
			let contextFile: string | null = null;
			if (params.includeContext) {
				try {
					const { messages } = buildSessionContext(ctx.sessionManager.getBranch());
					if (messages.length) {
						const md = renderAgentMessagesMarkdown(messages);
						const ctxDir = askContextDir();
						fs.mkdirSync(ctxDir, { recursive: true });
						contextFile = path.join(
							ctxDir,
							`.ask-context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
						);
						fs.writeFileSync(contextFile, md, { mode: 0o600 });
						effectivePrompt = `The full pi conversation context (as markdown) is at: ${contextFile}\nRead that file first for context, then do the task below.\n\n---\n\n${params.prompt}`;
					}
				} catch {
					// Fail soft: proceed isolated. details.includeContext reflects this.
					contextFile = null;
				}
			}

			const details: ClaudeDetails = {
				model: requestedModel,
				mode,
				effort,
				sessionId: isContinuation ? (rawSessionId as string) : null,
				includeContext: contextFile !== null,
				exitCode: 0,
				aborted: false,
				timedOut: false,
				resultIsError: false,
				resultSubtype: null,
				durationMs: 0,
				usage: null,
				costUsd: null,
				turns: null,
				stderr: "",
			};

			// Background: hand the run to the registry and return at once. The
			// result travels back through pi.sendMessage (wake), not this call.
			if (params.background) {
				if (ctx.mode === "print" || ctx.mode === "json") {
					if (contextFile) {
						try {
							fs.unlinkSync(contextFile);
						} catch {}
					}
					return {
						content: [
							{
								type: "text",
								text: "background is not available in print/json mode: the process exits before the result message can arrive. Call again without background.",
							},
						],
						details: { ...details },
					};
				}
				return startBackgroundRun({
					summary: params.prompt,
					binary,
					args,
					prompt: effectivePrompt,
					workdir,
					timeoutMin,
					startAt: Date.now(),
					details,
					contextFile,
					modelLabel: requestedModel,
				});
			}

			const start = Date.now();
			try {
				const outcome = await runClaudeProcess({
					binary,
					args,
					prompt: effectivePrompt,
					workdir,
					timeoutMin,
					startAt: start,
					details,
					signal,
					onPartial: onUpdate
						? (text) => {
								onUpdate({
									content: [{ type: "text", text }],
									details: { ...details, durationMs: Date.now() - start },
								});
							}
						: undefined,
				});

				details.stderr = outcome.stderrClean;
				details.exitCode = outcome.exitCode;
				details.aborted = outcome.aborted;
				details.timedOut = outcome.timedOut;
				details.durationMs = Date.now() - start;

				const finalText = shapeFinalText(details, outcome, timeoutMin);

				if (outcome.aborted || outcome.timedOut || outcome.exitCode !== 0) {
					return { content: [{ type: "text", text: finalText }], details };
				}

				onUpdate?.({
					content: [{ type: "text", text: "" }],
					details: { ...details },
				});

				return {
					content: [{ type: "text", text: finalText }],
					details,
				};
			} catch (err) {
				details.stderr = err instanceof ClaudeSpawnError ? err.stderrClean : "";
				details.durationMs = Date.now() - start;
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `failed to run claude: ${msg}` }],
					details,
				};
			} finally {
				if (contextFile) {
					try {
						fs.unlinkSync(contextFile);
					} catch {}
				}
			}
		},
	});
	// --- /claude-stop: kill a background run --------------------------------

	pi.registerCommand("claude-stop", {
		description: "Stop a background AskClaude run (id prefix, or the only running one). Usage: /claude-stop [runId]",
		handler: async (args, ctx) => {
			const message = await stopBackground(args ?? "");
			if (ctx.hasUI) ctx.ui.notify(message, "info");
		},
	});

	const startBackgroundRun = (o: {
		summary: string;
		binary: string;
		args: string[];
		prompt: string;
		workdir: string;
		timeoutMin: number;
		startAt: number;
		details: ClaudeDetails;
		contextFile: string | null;
		modelLabel: string;
	}): AskToolResult => {
		registry.sweep();
		let run;
		try {
			run = registry.start(summarizePrompt(o.summary));
		} catch (err) {
			if (o.contextFile) {
				try {
					fs.unlinkSync(o.contextFile);
				} catch {}
			}
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text",
						text: `background refused: ${msg}. Use blocking (omit background) or free a slot with /claude-stop.`,
					},
				],
				details: { ...o.details },
			};
		}
		const runId = run.runId;
		const cleanupStaging = () => {
			// The context file must outlive the execute() return in
			// background mode: claude reads it mid-run.
			if (o.contextFile) {
				try {
					fs.unlinkSync(o.contextFile);
				} catch {}
			}
		};
		cleanups.set(runId, cleanupStaging);
		void runClaudeProcess({
			binary: o.binary,
			args: o.args,
			prompt: o.prompt,
			workdir: o.workdir,
			timeoutMin: o.timeoutMin,
			startAt: o.startAt,
			details: o.details,
			onSpawn: (kill) => {
				kills.set(runId, kill);
			},
		})
			.then((outcome) => {
				kills.delete(runId);
				o.details.stderr = outcome.stderrClean;
				o.details.exitCode = outcome.exitCode;
				o.details.aborted = outcome.aborted;
				o.details.timedOut = outcome.timedOut;
				o.details.durationMs = Date.now() - o.startAt;
				const finalText = shapeFinalText(o.details, outcome, o.timeoutMin);
				const elapsedS = Math.round((Date.now() - o.startAt) / 1000);
				const handle = o.details.sessionId ? `sessionId=${o.details.sessionId}` : undefined;
				// The settle latch makes /claude-stop and shutdown win races
				// against this handler: a false return means their wake went out.
				const settled = registry.settle(runId, {
					status: outcome.timedOut || outcome.exitCode !== 0 ? "failed" : "done",
					output: finalText,
					handle,
					error: outcome.timedOut
						? `timeout after ${o.timeoutMin}m`
						: outcome.exitCode !== 0
							? `exit status ${outcome.exitCode}`
							: undefined,
				});
				if (!settled) return;
				if (outcome.timedOut) {
					const partial = outcome.answerText ? ` Partial output: ${outcome.answerText.slice(0, 400)}` : "";
					sendWake({ toolLabel: "Claude Code", runId, ok: false, elapsedS, error: `timeout after ${o.timeoutMin}m.${partial}`, handle });
				} else if (outcome.exitCode !== 0) {
					const reason = o.details.stderr.trim().slice(0, 400) || `exit status ${outcome.exitCode}`;
					sendWake({ toolLabel: "Claude Code", runId, ok: false, elapsedS, error: reason, handle });
				} else {
					sendWake({ toolLabel: "Claude Code", runId, ok: true, elapsedS, handle }, finalText);
				}
			})
			.catch((err) => {
				kills.delete(runId);
				const msg = err instanceof Error ? err.message : String(err);
				// Settle first: a /claude-stop that won the race owns the wake.
				const settled = registry.settle(runId, { status: "failed", error: msg });
				if (!settled) return;
				sendWake({ toolLabel: "Claude Code", runId, ok: false, error: `failed to run claude: ${msg}` });
			})
			.finally(() => {
				cleanups.delete(runId);
				cleanupStaging();
			});
		return {
			content: [
				{
					type: "text",
					text: `Background run ${runId} started (model=${o.modelLabel}). The result arrives as a message when claude finishes; the resume handle (sessionId) comes with it. Do not poll. Continue with other work or end the turn.`,
				},
			],
			details: { ...o.details },
		};
	};
}
