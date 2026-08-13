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

// --- Constants -------------------------------------------------------------

const DEFAULT_TIMEOUT_MIN = 10;
const GRACE_AFTER_TIMEOUT_MS = 5000;
const STATUS_INTERVAL_MS = 1000;
const DISCOVERY_TIMEOUT_MS = 8_000;

// renderCall / renderResult preview limits (match pi-claude-bridge).
const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

const DEFAULT_MODEL = "sonnet";
const DEFAULT_MODE = "read";
const DEFAULT_EFFORT = "default"; // "default" = omit --effort (Claude's own default)

const BRIDGE_PACKAGE_ID = "pi-claude-bridge";
const BRIDGE_CONFIG_NAME = "claude-bridge.json";

// Claude session ids and --session-id values are UUIDs. Anchored to UUID
// shape so a leading-dash value (e.g. "--verbose") can NEVER pass and
// misbind on claude's arg parser as the token after --resume / --session-id.
const SESSION_ID_RE =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const CLAUDE_DESCRIPTION = `Delegate a self-contained sub-task to Claude Code. This is the standalone Claude-Code-specific delegation tool (it shells out to \`claude -p\`). It is distinct from the AskClaude tool provided by pi-claude-bridge: that one shares the pi conversation via the Agent SDK; this one runs an isolated Claude Code subprocess. When the user says "ask claude", "ask claude code", or otherwise refers to delegating to Claude Code, call THIS tool. Claude runs its OWN tool loop (Read, Grep, Edit, Bash, ...) inside the workspace, then returns its final answer. Use for a second opinion, code review, architecture questions, debugging theories, or to autonomously handle a task you do not need to drive step-by-step. Provide a complete, self-contained task description; Claude will not see this conversation unless you resume a prior session.

TWO MODES (you choose):
- **One-shot (isolated)**: omit sessionId. Claude starts a fresh session with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the sessionId returned in the PREVIOUS call's details (details.sessionId). Claude resumes that session with full context intact — use for follow-ups, multi-turn refinement, or when the user says "ask claude to follow up / continue / now do X based on what you just did". Thread the id from each result into the next call.

PERMISSION MODES (the \`mode\` param):
- **read** (default): research / analysis / review with file access but no mutations. Restricts Claude to read-only tools (Read/Grep/Glob/LS/WebSearch/WebFetch).
- **none**: general knowledge only — no file or tool access at all.
- **full**: allows file edits and bash execution (skips per-action permission checks). Use only when the user wants Claude to make changes.`;

// --- Types -----------------------------------------------------------------

type Effort = "default" | "low" | "medium" | "high" | "xhigh";
type PermissionMode = "read" | "none" | "full";

interface Config {
	defaultModel: string;
	defaultMode: PermissionMode;
	defaultEffort: Effort;
	allowFullMode: boolean;
}

// Minimal shapes for the JSONL stream-json events we consume. Unknown
// fields are ignored. See: Claude Code CLI `--output-format stream-json`.
interface ClaudeStreamEvent {
	type: string;
	subtype?: string;
	session_id?: string;
	result?: string;
	is_error?: boolean;
	num_turns?: number;
	total_cost_usd?: number;
	duration_ms?: number;
	usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
	message?: {
		role?: string;
		// Unified block shape: a discriminated union collapses here because
		// { type: "tool_use" } is assignable to a { type: string } fallback, so
		// one object with all-optional fields keeps `block.type === "tool_use"`
		// narrowing AND lets us read name/input/text/is_error without casts.
		content?: Array<{
			type: string;
			text?: string;
			thinking?: string;
			name?: string;
			input?: Record<string, unknown>;
			is_error?: boolean;
		}>;
	};
}

// --- Config ----------------------------------------------------------------

function globalConfigPath(): string {
	return path.join(getAgentDir(), "ask-claude.json");
}

function projectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "ask-claude.json");
}

export function tryReadJson(filePath: string): Record<string, unknown> {
	if (!filePath || !fs.existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
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
	const global = tryReadJson(globalConfigPath());
	const project = tryReadJson(projectConfigPath(cwd));
	const merged = { ...global, ...project };

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

interface SaveResult {
	path: string;
	/** True when the write went to the project config (project shadows global). */
	routedToProject: boolean;
}

/** Persist a config patch. If the project config already defines any patched
 *  key, write to the PROJECT file so the change actually takes effect
 *  (project shadows global on load); otherwise write to global.
 *  Atomic: temp file + rename, with temp cleanup on failure. */
function saveConfig(cwd: string, patch: Partial<Config>): SaveResult {
	const projectRaw = tryReadJson(projectConfigPath(cwd));
	const projectShadows = Object.keys(patch).some((k) => k in projectRaw);
	const targetPath = projectShadows ? projectConfigPath(cwd) : globalConfigPath();

	const existing = tryReadJson(targetPath);
	const next = { ...existing, ...patch };
	const dir = path.dirname(targetPath);
	fs.mkdirSync(dir, { recursive: true });

	const tmp = `${targetPath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, targetPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw err;
	}
	return { path: targetPath, routedToProject: projectShadows };
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

// --- Argv building (exported for tests) ------------------------------------

// Read-only tool allowlist for `read` mode. These tools never trigger a
// permission prompt, so the run stays fully non-interactive in --print
// mode. Mutating tools (Edit/Write/Bash/...) are simply absent, so Claude
// cannot change anything; MCP and subagent tools are excluded too.
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "TodoWrite"];

export interface BuildArgsOptions {
	model?: string;
	effort: Effort;
	mode: PermissionMode;
	allowFullMode: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	sessionId?: string; // defined + valid UUID => resume; undefined => fresh
	extraArgs: string[];
}

/** Build the `claude` argv. The PROMPT IS NOT INCLUDED here: it is delivered
 *  via stdin, because `--allowedTools` / `--tools` are variadic flags that
 *  would otherwise swallow a positional prompt. Pure function so tests can
 *  pin the shape. `plan` mode is deliberately avoided — it needs interactive
 *  plan approval and errors out headless (error_during_execution). */
export function buildClaudeArgs(opts: BuildArgsOptions): string[] {
	const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
	args.push(...opts.extraArgs);

	if (opts.model && opts.model.trim()) args.push("--model", opts.model.trim());
	if (opts.effort !== "default") args.push("--effort", opts.effort);

	// Permission / tool surface per mode.
	if (opts.mode === "full") {
		if (!opts.allowFullMode) {
			// Caller should have rejected this already; degrade to read.
			args.push("--allowedTools", READ_ONLY_TOOLS.join(","));
		} else {
			args.push("--permission-mode", "bypassPermissions");
		}
	} else if (opts.mode === "none") {
		// Disable every built-in tool: pure general knowledge.
		args.push("--tools", "");
	} else {
		// read: explicit read-only allowlist (no prompts, no mutations).
		args.push("--allowedTools", READ_ONLY_TOOLS.join(","));
	}

	if (opts.systemPrompt && opts.systemPrompt.trim()) {
		args.push("--system-prompt", opts.systemPrompt);
	}
	if (opts.appendSystemPrompt && opts.appendSystemPrompt.trim()) {
		args.push("--append-system-prompt", opts.appendSystemPrompt);
	}

	if (opts.sessionId && SESSION_ID_RE.test(opts.sessionId)) {
		args.push("--resume", opts.sessionId);
	}
	// Fresh runs do NOT pass --session-id: claude assigns the id and reports
	// it in the `system/init` event, which we capture during streaming.

	return args;
}


// --- Status rendering ------------------------------------------------------

function shorten(text: string, limit = 96): string {
	const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
	if (!normalized) return "";
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, limit - 3)}...`;
}

function toolUseStatus(name: string | undefined, input: Record<string, unknown> | undefined): string {
	const n = String(name ?? "tool");
	switch (n) {
		case "Read":
			return `reading: ${shorten(String(input?.file_path ?? ""), 120)}`;
		case "Grep":
		case "Glob":
		case "LS":
			return `searching: ${shorten(String(input?.pattern ?? input?.path ?? ""), 120)}`;
		case "Edit":
		case "Write":
		case "NotebookEdit":
			return `editing: ${shorten(String(input?.file_path ?? ""), 120)}`;
		case "Bash":
			return `running: ${shorten(String(input?.command ?? ""), 140)}`;
		case "WebSearch":
			return `web search: ${shorten(String(input?.query ?? ""), 120)}`;
		case "WebFetch":
			return `web fetch: ${shorten(String(input?.url ?? ""), 120)}`;
		case "Task":
		case "TaskCreate":
		case "TaskUpdate":
			return `subtask: ${n}`;
		case "TodoWrite":
			return "plan updated";
		default:
			return `tool: ${n}`;
	}
}

/** Map one parsed stream event to a short human status line, or null when
 *  the event carries nothing worth surfacing (keeps status lean). */
function describeStreamEvent(ev: ClaudeStreamEvent): string | null {
	// SessionStart / hook lifecycle events are config noise, not progress.
	if (ev.type === "system") {
		return null;
	}
	if (ev.type === "assistant" && ev.message?.content) {
		for (const block of ev.message.content) {
			if (block.type === "tool_use") {
				return toolUseStatus(block.name, block.input);
			}
		}
		// Text/thinking-only assistant turn: no per-line status (the final
		// answer comes from the `result` event).
		return null;
	}
	if (ev.type === "user" && ev.message?.content) {
		for (const block of ev.message.content) {
			if (block.type === "tool_result" && block.is_error) return "tool error";
		}
		return null;
	}
	return null;
}

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
						"read (default): research/analysis with file access, no mutations. none: general knowledge only. full: edits + bash (gated by allowFullMode).",
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
						"Permission mode: 'read' (default, research/analysis with file access, no mutations), 'none' (general knowledge only, no tools), or 'full' (edits + bash, skips per-action permission checks). Overrides the configured default.",
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
		}),
		renderCall(args, theme, context) {
			// Show RESOLVED model/thinking/mode (config defaults applied) so the
			// row identifies what will actually run, not just explicit args.
			const cfg = loadConfig(context.cwd);
			const model = (args.model as string | undefined)?.trim() || cfg.defaultModel;
			const effort: Effort = isEffort(args.thinking) ? args.thinking : cfg.defaultEffort;
			const mode: PermissionMode = isPermissionMode(args.mode) ? args.mode : cfg.defaultMode;
			const isContinue =
				typeof args.sessionId === "string" && SESSION_ID_RE.test(args.sessionId);

			const tags: string[] = [`model=${model}`, `thinking=${effort}`];
			if (mode !== cfg.defaultMode) tags.push(`mode=${mode}`);
			if (isContinue) tags.push("continue");
			if (args.includeContext) tags.push("context=full");

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
			if (d?.mode && d.mode !== "read") text += ` ${theme.fg("muted", d.mode)}`;
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

			const start = Date.now();
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
				typeof rawSessionId === "string" && rawSessionId.length > 0 && SESSION_ID_RE.test(rawSessionId);

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

			let finalMessage = "";
			let assistantText = ""; // fallback if no result event
			const statusLines: string[] = [];

			const statusInterval = onUpdate
				? setInterval(() => {
						const elapsed = Math.floor((Date.now() - start) / 1000);
						const tail = statusLines.slice(-3).join("\n");
						const text = tail ? `(running ${elapsed}s)\n${tail}` : `(running ${elapsed}s)`;
						onUpdate({
							content: [{ type: "text", text }],
							details: { ...details, durationMs: Date.now() - start },
						});
					}, STATUS_INTERVAL_MS)
				: null;

			let stderrBuf = "";
			try {
				const outcome = await new Promise<{
					exitCode: number;
					aborted: boolean;
					timedOut: boolean;
				}>((resolveP, rejectP) => {
					const proc = spawn(binary, args, {
						cwd: workdir,
						stdio: ["pipe", "pipe", "pipe"],
						shell: false,
						detached: true,
					});

					// Deliver the prompt via stdin (see buildClaudeArgs: variadic flags
					// would eat a positional). Write then end so claude proceeds
					// without its 3s stdin-wait. Ignore EPIPE if claude exits first.
					proc.stdin?.on("error", () => {});
					proc.stdin?.write(effectivePrompt);
					proc.stdin?.end();

					let stdoutBuf = "";
					proc.stdout?.setEncoding("utf8");
					proc.stderr?.setEncoding("utf8");

					const handleLine = (line: string) => {
						const trimmed = line.trim();
						if (!trimmed) return;
						let ev: ClaudeStreamEvent;
						try {
							ev = JSON.parse(trimmed) as ClaudeStreamEvent;
						} catch {
							return;
						}
						consumeEvent(ev);
					};

					const consumeEvent = (ev: ClaudeStreamEvent) => {
						// Confirm/repair session id from the init event.
						if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
							if (!details.sessionId) details.sessionId = ev.session_id;
						}
						if (ev.type === "result") {
							if (typeof ev.result === "string") finalMessage = ev.result;
							if (typeof ev.is_error === "boolean") details.resultIsError = ev.is_error;
							if (typeof ev.subtype === "string") details.resultSubtype = ev.subtype;
							if (ev.usage) {
								details.usage = {
									inputTokens: ev.usage.input_tokens ?? 0,
									outputTokens: ev.usage.output_tokens ?? 0,
									cacheReadTokens: ev.usage.cache_read_input_tokens ?? 0,
									cacheWriteTokens: ev.usage.cache_creation_input_tokens ?? 0,
								};
							}
							if (typeof ev.total_cost_usd === "number") details.costUsd = ev.total_cost_usd;
							if (typeof ev.num_turns === "number") details.turns = ev.num_turns;
							return;
						}
						// Accumulate assistant text as a fallback for the final
						// answer when no `result` event is emitted (timeout/abort).
						if (ev.type === "assistant" && ev.message?.content) {
							for (const block of ev.message.content) {
								if (block.type === "text" && block.text) {
									assistantText += block.text;
								}
							}
						}
						const line = describeStreamEvent(ev);
						if (line) statusLines.push(line);
					};

					proc.stdout?.on("data", (d: string) => {
						stdoutBuf += d;
						let nl: number;
						while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
							handleLine(stdoutBuf.slice(0, nl));
							stdoutBuf = stdoutBuf.slice(nl + 1);
						}
					});
					proc.stderr?.on("data", (d: string) => {
						stderrBuf += d;
					});

					let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
					let watchdog: ReturnType<typeof setTimeout> | undefined;
					let settled = false;
					let timedOut = false;

					const killTree = () => {
						try {
							if (proc.pid) process.kill(-proc.pid, "SIGTERM");
						} catch {}
						if (!sigkillTimer) {
							sigkillTimer = setTimeout(() => {
								try {
									if (proc.pid) process.kill(-proc.pid, "SIGKILL");
								} catch {}
							}, GRACE_AFTER_TIMEOUT_MS);
						}
					};

					const cleanup = () => {
						if (watchdog) clearTimeout(watchdog);
						if (sigkillTimer) clearTimeout(sigkillTimer);
						if (signal) signal.removeEventListener("abort", onAbort);
					};

					const onAbort = () => killTree();

					watchdog = setTimeout(() => {
						timedOut = true;
						killTree();
					}, timeoutMin * 60_000);

					if (signal) {
						if (signal.aborted) killTree();
						else signal.addEventListener("abort", onAbort, { once: true });
					}

					const finish = (code: number | null) => {
						if (settled) return;
						settled = true;
						cleanup();
						if (stdoutBuf.trim()) handleLine(stdoutBuf);
						resolveP({
							exitCode: code ?? 0,
							aborted: !!signal?.aborted,
							timedOut,
						});
					};

					proc.on("error", (err) => {
						cleanup();
						rejectP(err);
					});
					proc.on("close", finish);
				});

				if (statusInterval) clearInterval(statusInterval);

				details.stderr = cleanStderr(stderrBuf);
				details.exitCode = outcome.exitCode;
				details.aborted = outcome.aborted;
				details.timedOut = outcome.timedOut;
				details.durationMs = Date.now() - start;

				const text = (finalMessage || assistantText).trim();
				// claude can exit 0 while the result event carries is_error
				// (error_during_execution, max_turns, refusal). Surface it so a
				// failed run is never reported to the orchestrator as a clean answer.
				const isErrorNote =
					details.resultIsError && outcome.exitCode === 0
						? `\n\n[claude reported an error${details.resultSubtype ? `: ${details.resultSubtype}` : ""} — the answer above may be incomplete or unreliable]`
						: "";

				if (outcome.aborted) {
					return {
						content: [
							{
								type: "text",
								text: text ? `claude was aborted. Partial answer:\n\n${text}` : "claude was aborted before producing output.",
							},
						],
						details,
					};
				}

				if (outcome.timedOut) {
					const note = `claude exceeded the ${timeoutMin}m timeout and was killed`;
					return {
						content: [{ type: "text", text: text ? `${text}\n\n[${note}]` : note }],
						details,
					};
				}

				if (outcome.exitCode !== 0) {
					const note = details.stderr.trim()
						? `claude exited with status ${outcome.exitCode}: ${details.stderr.trim()}`
						: `claude exited with status ${outcome.exitCode}`;
					return {
						content: [{ type: "text", text: text ? `${text}\n\n[${note}]` : note }],
						details,
					};
				}

				onUpdate?.({
					content: [{ type: "text", text: "" }],
					details: { ...details },
				});

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

				return {
					content: [{ type: "text", text: (text || "(claude returned no message)") + isErrorNote + footer + usageSuffix + costSuffix }],
					details,
				};
			} catch (err) {
				if (statusInterval) clearInterval(statusInterval);
				details.stderr = cleanStderr(stderrBuf);
				details.durationMs = Date.now() - start;
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `failed to run claude: ${msg}` }],
					details,
				};
			}
			finally {
				if (contextFile) {
					try {
						fs.unlinkSync(contextFile);
					} catch {}
				}
			}
		},
	});
}

/** Drop claude stderr lines that aren't real errors: the stdin-wait notice
 *  and benign config warnings. */
export function cleanStderr(buf: string): string {
	return buf
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter(
			(l) =>
				l &&
				!l.startsWith("Warning: no stdin data received") &&
				!/^claude:?\s*$/i.test(l),
		)
		.join("\n");
}
