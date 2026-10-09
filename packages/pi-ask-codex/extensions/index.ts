/**
 * AskCodex — delegate a self-contained sub-task to OpenAI's Codex CLI.
 * The AskClaude-style delegation pattern, pointed at GPT via `codex exec`.
 *
 * One self-contained tool. Spawns `codex exec --json`, parses the JSONL event
 * stream for structured progress + the final agent message, and returns it.
 * Codex runs its OWN tool loop (read, write, edit, exec) inside the workspace.
 *
 * Model aliases: friendly names resolve to whatever Codex currently advertises
 * via `codex debug models --bundled`. No version strings are hardcoded — the
 * catalog is fetched once at extension load and the highest version wins.
 *   "default"        -> omit --model (Codex's own default)
 *   "mini" / "nano"  -> highest-version fast family (luna)
 *   "astra"          -> highest-version frontier family
 *   "full" / "gpt"   -> highest-version main family (sol)
 *   "6 mini"         -> pinned version + family
 *   "gpt-6.1-sol"    -> exact passthrough (verifies against catalog; falls
 *                       through to codex verbatim if discovery is unavailable)
 * Deprecated catalog models carry an `upgrade` pointer; resolved requests
 * auto-migrate to the official upgrade target instead of failing server-side.
 *
 * Config: ~/.pi/agent/ask-codex.json (global) merged over
 *         .pi/ask-codex.json (project). Editable via /codex.
 *
 * Two modes (agent decides per call):
 *   - omit sessionId    -> one-shot, Codex starts fresh
 *   - pass sessionId     -> resume that Codex session (full context)
 * The id is read directly from the `thread.started` JSON event (Codex prints
 * it; no snapshot/diff needed). Continuation uses `codex exec resume <id>`.
 *
 * Env:  CODEX_BIN (binary path), CODEX_EXTRA_ARGS (extra args; the value is
 *       parsed with a shell-like splitter so quoted args with spaces work).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
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
	buildCodexArgs,
	cleanCodexStderr,
	CODEX_SESSION_ID_RE,
	compareVersionsDesc,
	configPaths,
	discoverCodexModels,
	classifySlug,
	consumeCodexEvent,
	createStopHandler,
	createWakeSender,
	emptyCodexEventState,
	loadLayeredRaw,
	REASONING_VALUES,
	resolveCodexModel,
	RunSpawnError,
	runProcess,
	saveLayeredConfig,
	SANDBOX_VALUES,
	summarizePrompt,
	tryReadJson,
	type CodexEvent,
	type CodexModelEntry,
	type SaveResult,
} from "@estebanforge/pi-ask-shared";

// --- Constants -------------------------------------------------------------

const DEFAULT_TIMEOUT_MIN = 10;
const STATUS_INTERVAL_MS = 1000;
const DISCOVERY_TIMEOUT_MS = 8_000;

// renderCall / renderResult preview limits (match pi-claude-bridge).
const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

const DEFAULT_MODEL = "default";
const DEFAULT_REASONING = "medium";
// Pi philosophy: pi's own bash tool has no sandbox and no approval gate, so
// the delegation default matches: full tool access, no prompts. Restrict per
// call (sandbox param) or via defaultSandbox in ask-codex.json when needed.
const DEFAULT_SANDBOX = "danger-full-access";

// Codex session ids live in the shared peer adapter (CODEX_SESSION_ID_RE):
// UUID-anchored so a leading-dash value can never misbind as the resume
// positional (which would silently disable the sandbox).

const CODEX_DESCRIPTION = `Delegate a self-contained sub-task to OpenAI Codex. This tool answers to three equivalent names the user may use interchangeably: **codex**, **openai**, and **gpt**. When the user says "ask codex", "ask openai", "ask gpt", or otherwise refers to any of these, call THIS tool. Codex runs its OWN tool loop: it can read, write, edit, and execute inside the workspace, then returns its final answer. Use for a second opinion from a different model family, GPT-specific reasoning, or isolated sub-tasks you do not need to drive step-by-step. Provide a complete, self-contained task description; Codex will not see this conversation.

TWO MODES (you choose):
- **One-shot (isolated)**: omit sessionId. Codex starts fresh with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the sessionId returned in the PREVIOUS call's details (details.sessionId). Codex resumes that session with full context intact — use for follow-ups, multi-turn refinement, or when the user says "ask codex to follow up / continue / now do X based on what you just did". Thread the id from each result into the next call.

THINKING / REASONING EFFORT (params: thinking, reasoningEffort - SYNONYMS for one knob):
- pi calls it thinking, Codex calls it reasoning effort. Same thing. Pass ONE of the two.
- Values: low|medium|high|xhigh|max|ultra ("minimal" is retired; support
  is validated per model — e.g. gpt-6-luna has no ultra).
- An explicit level beats the configured default. Lowering it is the primary speed/cost lever.`;

// --- Types -----------------------------------------------------------------

type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface Config {
	defaultModel: string;
	defaultReasoning: ReasoningEffort;
	defaultSandbox: SandboxMode;
}

// --- Config ----------------------------------------------------------------

/** Layered config paths: global is ~/.pi/agent (homedir, NOT getAgentDir —
 *  today's shipped resolution for this extension); project is <cwd>/.pi. */
function configPathsFor() {
	return configPaths({
		globalDir: path.join(os.homedir(), ".pi", "agent"),
		projectDir: path.join(process.cwd(), ".pi"),
		fileName: "ask-codex.json",
	});
}

function isReasoningEffort(v: unknown): v is ReasoningEffort {
	return typeof v === "string" && (REASONING_VALUES as readonly string[]).includes(v);
}
function isSandboxMode(v: unknown): v is SandboxMode {
	return typeof v === "string" && (SANDBOX_VALUES as readonly string[]).includes(v);
}

function loadConfig(): Config {
	const { merged } = loadLayeredRaw(configPathsFor());

	const reasoningRaw = String(merged.defaultReasoning ?? DEFAULT_REASONING).toLowerCase();
	const reasoning: ReasoningEffort = isReasoningEffort(reasoningRaw) ? reasoningRaw : DEFAULT_REASONING;

	const sandboxRaw = String(merged.defaultSandbox ?? DEFAULT_SANDBOX).toLowerCase();
	const sandbox: SandboxMode = isSandboxMode(sandboxRaw) ? sandboxRaw : DEFAULT_SANDBOX;

	return {
		defaultModel: String(merged.defaultModel ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
		defaultReasoning: reasoning,
		defaultSandbox: sandbox,
	};
}

/** Persist a config patch via the shared all-or-nothing router: if any
 *  patched key is already project-defined, the whole patch goes to the
 *  project file (it shadows global on load). Atomic write inside. */
function saveConfig(patch: Partial<Config>): SaveResult {
	return saveLayeredConfig(configPathsFor(), patch as Record<string, unknown>);
}

// --- Model discovery + alias resolution ------------------------------------
// The slug taxonomy (classifySlug), the alias resolver (resolveModel), the
// alias resolver (resolveModel), and the version
// compare all live in pi-ask-shared (peers/codex.ts) so pi-unblock consults
// reuse the exact same resolution contract.

// bundled-catalog discovery probe: discoverCodexModels lives in the shared
// peer adapter (peers/codex.ts) alongside the model grammar it parses; the
// extension imports it back below.
// --- Status rendering: shared peer adapter ---------------------------------
// looksLikeVerificationCommand, shorten, and describeItem (the item.*
// status vocabulary) live in pi-ask-shared (peers/codex.ts) alongside the
// event grammar they interpret; the extension only consumes statusLines.

// --- codex process helpers -------------------------------------------------

function resolveCodex(): string {
	return process.env.CODEX_BIN || "codex";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Shell-like argument splitter for CODEX_EXTRA_ARGS: respects "..." and '...'
 *  quoted segments so a value with spaces stays one arg. Bare tokens split on
 *  whitespace. NOTE: backslash escapes are NOT unescaped — a literal `\"`
 *  inside a quoted segment stays in the arg. CODEX_EXTRA_ARGS is trusted env
 *  set by the user, so this is cosmetic, not a security issue. */
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
	const raw = process.env.CODEX_EXTRA_ARGS;
	return raw ? splitArgs(raw) : [];
}

/** Best-effort version check: `codex --version` exits 0 and prints a version
 *  string. Used to fail fast with a clear message instead of an opaque spawn
 *  error inside the tool call. */
async function codexAvailable(binary: string): Promise<boolean> {
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
		return /codex/i.test(out);
	} catch {
		return false;
	}
}

// --- Full-context export (opt-in includeContext) --------------------------
// NOTE: duplicated per pi-ask-* package (each is self-contained). Duck-typed
// over role/content to tolerate AgentMessage's union + custom message types.

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
	return path.join(path.dirname(getAgentDir()), "extensions-data", "estebanforge", "pi-ask-codex");
}

// --- Extension -------------------------------------------------------------

interface CodexDetails {
	model: string | null;
	resolvedModel: string | null;
	reasoning: ReasoningEffort | null;
	sandbox: SandboxMode | null;
	sessionId: string | null;
	includeContext: boolean;
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	durationMs: number;
	usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null;
	stderr: string;
}

function emptyDetails(
	model: string | null,
	resolvedModel: string | null,
	reasoning: ReasoningEffort | null = null,
	sandbox: SandboxMode | null = null,
	includeContext: boolean = false,
): CodexDetails {
	return {
		model,
		resolvedModel,
		reasoning,
		sandbox,
		sessionId: null,
		includeContext,
		exitCode: 0,
		aborted: false,
		timedOut: false,
		durationMs: 0,
		usage: null,
		stderr: "",
	};
}


// --- Background-mode plumbing ----------------------------------------------
// Shared shape for both call styles: blocking awaits it, background lets it
// run detached and pushes the outcome through the wake sender on close.
// Process mechanics (spawn/kill-tree/watchdog/settle-on-close) live in the
// shared runProcess; this layer owns the codex stream contract + status.

/** Spawn failure (binary vanished between the availability check and spawn). Carries whatever stderr accumulated. */
class CodexSpawnError extends Error {
	readonly stderrClean: string;
	constructor(message: string, stderrClean: string) {
		super(message);
		this.stderrClean = stderrClean;
	}
}

interface ProcessRunOptions {
	binary: string;
	args: string[];
	workdir: string;
	timeoutMin: number;
	startAt: number;
	/** Mutated in place: sessionId (thread_id), usage. */
	details: CodexDetails;
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
	/** Final agent message. Already trimmed. */
	answerText: string;
	stderrClean: string;
}

/** Tool-result shape this extension returns; keeps the background helper's literals narrow. */
interface AskToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: CodexDetails;
}

/**
 * Spawns codex exec via the shared runProcess, consumes the --json event
 * stream through the shared peer adapter, and resolves when the process
 * tree closes. Process mechanics (kill-tree, watchdog, abort, settle-on-
 * close) are runProcess's; this layer owns only the codex stream contract
 * and the throttled status partials. stdin is NOT used: codex takes the
 * prompt as a trailing positional (see buildCodexArgs).
 */
async function runCodexProcess(opts: ProcessRunOptions): Promise<ProcessRunOutcome> {
	const { binary, args, workdir, timeoutMin, startAt, details, signal, onPartial, onSpawn } = opts;
	const st = emptyCodexEventState();

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
				cwd: workdir,
				timeoutMs: timeoutMin * 60_000,
				signal,
				onLine: (line) => {
					const trimmed = line.trim();
					if (!trimmed) return;
					try {
						consumeCodexEvent(JSON.parse(trimmed) as CodexEvent, st);
					} catch {
						return; // not JSON — ignore (shouldn't happen with --json)
					}
					// Mirror the accumulator onto details so partial progress
					// keeps showing live sessionId/usage. Latest thread_id wins
					// (codex echoes the resumed id on continuation runs).
					if (st.sessionId) details.sessionId = st.sessionId;
					details.usage = st.usage;
				},
				onSpawn,
			});
		} catch (err) {
			// Preserve the extension's spawn-error contract (cleaned stderr).
			if (err instanceof RunSpawnError) throw new CodexSpawnError(err.message, cleanCodexStderr(err.stderr));
			throw err;
		}
		return {
			exitCode: outcome.exitCode,
			aborted: outcome.aborted,
			timedOut: outcome.timedOut,
			answerText: st.finalMessage.trim(),
			stderrClean: cleanCodexStderr(outcome.stderr),
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
function shapeFinalText(details: CodexDetails, outcome: ProcessRunOutcome, timeoutMin: number): string {
	const text = outcome.answerText;

	if (outcome.aborted) {
		return text ? `codex was aborted. Partial answer:\n\n${text}` : "codex was aborted before producing output.";
	}
	if (outcome.timedOut) {
		const note = `codex exceeded the ${timeoutMin}m timeout and was killed`;
		return text ? `${text}\n\n[${note}]` : note;
	}
	// Non-zero exit: surface the failure even when partial text exists.
	if (outcome.exitCode !== 0) {
		const note = details.stderr.trim()
			? `codex exited with status ${outcome.exitCode}: ${details.stderr.trim()}`
			: `codex exited with status ${outcome.exitCode}`;
		return text ? `${text}\n\n[${note}]` : note;
	}

	// Session footer lets the orchestrating model thread the id without details.
	const footer = details.sessionId
		? `\n\n[codex sessionId: ${details.sessionId} — pass as sessionId to continue this conversation]`
		: "";
	const usageSuffix = details.usage
		? `\n[tokens: ${details.usage.inputTokens} in / ${details.usage.outputTokens} out${details.usage.reasoningTokens > 0 ? ` / ${details.usage.reasoningTokens} reasoning` : ""}]`
		: "";

	return (text || "(codex returned no message)") + footer + usageSuffix;
}

export default async function (pi: ExtensionAPI) {
	const binary = resolveCodex();
	// Run both discovery probes in parallel: each carries its own 8s
	// watchdog, so worst-case load time is 8s instead of 16s. Either
	// failure is non-fatal (the other still completes).
	const [available, discovered] = await Promise.all([
		codexAvailable(binary).catch(() => false),
		discoverCodexModels(binary).catch(() => []),
	]);

	// --- Background-run state (one set per extension load) -------------------
	// Pi wipes module state on /new, /resume, /fork and /reload: an in-flight
	// background run is killed and its result is never delivered. Accepted
	// trade-off, documented in the README.
	const registry = new BackgroundRunRegistry({ toolName: "ask-codex" });
	const kills = new Map<string, () => void>();
	// Staged-artifact cleanup (contextFile), keyed by run: the session_shutdown
	// backstop runs these when a hard exit would skip the close-path finally.
	const cleanups = new Map<string, () => void>();
	const sendWake = createWakeSender(pi, {
		customType: "ask-codex-result",
		isDisposed: () => registry.isDisposed(),
	});
	const stopBackground = createStopHandler(registry, {
		kill: (run) => kills.get(run.runId)?.(),
		onStopped: (run) =>
			sendWake({
				toolLabel: "Codex",
				runId: run.runId,
				ok: false,
				elapsedS: Math.round((Date.now() - run.startedAt) / 1000),
				error: "stopped via /codex-stop",
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

	// --- /codex: view / change defaults -----------------------------------

	const MODEL_OPTIONS = ["default", "mini", "astra", "full"];
	const REASONING_OPTIONS: ReasoningEffort[] = [...REASONING_VALUES];
	const SANDBOX_OPTIONS: SandboxMode[] = [...SANDBOX_VALUES];

	pi.registerCommand("codex", {
		description: "AskCodex config: show status, or open the model/effort/sandbox picker. Usage: /codex",
		handler: async (_args, ctx) => {
			const config = loadConfig();

			// Headless / RPC fallback: print a status snapshot.
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					[
						`AskCodex config`,
						`  codex available:  ${available ? "yes" : "NO (check PATH / CODEX_BIN)"}`,
						`  defaultModel:     ${config.defaultModel}`,
						`  resolved:         ${resolveCodexModel(config.defaultModel, discovered).flagValue ?? "(codex default)"}`,
						`  catalog:          ${discovered.length} model(s) discovered`,
						`  defaultReasoning: ${config.defaultReasoning}`,
						`  defaultSandbox:   ${config.defaultSandbox}`,
						``,
						`Edit: ~/.pi/agent/ask-codex.json`,
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
						"Friendly alias resolved at runtime via `codex debug models --bundled`. 'default' = omit the flag (Codex's own default); 'mini' = fast tier (luna); 'astra' = frontier tier; 'full' = workhorse tier (sol). No version strings are hardcoded — pick whichever is current.",
					currentValue: config.defaultModel,
					values: MODEL_OPTIONS,
				},
				{
					id: "defaultReasoning",
					label: "Default reasoning effort",
					description:
						"Reasoning effort passed via -c model_reasoning_effort. Lower = faster and cheaper; higher = more thorough. 'medium' is a good default.",
					currentValue: config.defaultReasoning,
					values: REASONING_OPTIONS,
				},
				{
					id: "defaultSandbox",
					label: "Default sandbox",
					description:
						"Codex sandbox policy. 'danger-full-access' (default) is unrestricted, full tool access without prompts; 'workspace-write' edits files in cwd only; 'read-only' inspects without acting.",
					currentValue: config.defaultSandbox,
					values: SANDBOX_OPTIONS,
				},
			];

			const pending: Partial<Config> = {};

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(
					new Text(theme.fg("accent", theme.bold("AskCodex defaults")), 1, 1),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 4, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						if (id === "defaultModel") {
							pending.defaultModel = newValue;
						} else if (id === "defaultReasoning") {
							if (isReasoningEffort(newValue)) pending.defaultReasoning = newValue;
						} else if (id === "defaultSandbox") {
							if (isSandboxMode(newValue)) pending.defaultSandbox = newValue;
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
				const result = saveConfig(pending);
				const changed = Object.entries(pending)
					.map(([k, v]) => `${k}=${v}`)
					.join(", ");
				const where = result.routedToProject
					? "(written to project .pi/ask-codex.json — it shadows global)"
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

	// Free string, not a StringEnum: aliases (default/mini/full/gpt/nano/pro/codex)
	// resolve via the catalog at load, but arbitrary exact slugs still pass through
	// so API-key-authenticated users can target any model codex supports. A
	// bounded enum would make that passthrough branch dead code.
	const modelParam = Type.Optional(
		Type.String({
			description:
				"Model alias or exact id. Friendly: 'default' (omit flag, codex picks), 'mini' (fast tier, gpt-6-luna), 'astra' (frontier tier), 'full' / 'gpt' (workhorse tier, highest version). Pin a version: '6 mini', '6.1 full'. Exact slugs pass through verbatim (e.g. 'gpt-6.1-sol', or any model your auth allows). Deprecated catalog models auto-migrate to their official upgrade target. Omit for the configured default.",
		}),
	);

	pi.registerTool({
		name: "AskCodex",
		label: "Ask Codex",
		description: CODEX_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained task for Codex. Include all context Codex needs; it cannot see this conversation.",
			}),
			cwd: Type.Optional(
				Type.String({
					description: "Absolute workspace path Codex runs in. Defaults to the current project root.",
				}),
			),
			model: modelParam,
			reasoningEffort: Type.Optional(
				StringEnum(REASONING_VALUES, {
					description:
						"Reasoning effort: 'low' (fast, cheap) through 'ultra' (maximum depth). Overrides the configured default. Lowering this is the primary lever for speed/cost. Validated against the resolved model's supported ladder.",
				}),
			),
			thinking: Type.Optional(
				StringEnum(REASONING_VALUES, {
					description:
						"Alias for `reasoningEffort` (pi calls it thinking, Codex reasoning effort). Same knob. Pass ONE of the two; different values on both is an error.",
				}),
			),
			sandbox: Type.Optional(
				StringEnum(SANDBOX_VALUES, {
					description:
						"Sandbox policy: 'danger-full-access' (default, unrestricted, no approval prompts), 'workspace-write' (edit files in cwd), 'read-only' (inspect, no writes). Overrides the configured default.",
				}),
			),
			sessionId: Type.Optional(
				Type.String({
					description:
						"Omit for a one-shot (Codex starts fresh). To CONTINUE a previous Codex session with its context intact, pass the sessionId returned in that call's details. Codex resumes that session.",
				}),
			),
			timeoutMinutes: Type.Optional(
				Type.Number({
					description: `Hard cap on the Codex run in minutes. Default ${DEFAULT_TIMEOUT_MIN}.`,
				}),
			),
			includeContext: Type.Optional(
				Type.Boolean({
					description:
						"When true, export the current pi conversation (resolved, as markdown) to a temp file inside the workspace and tell Codex to read it first. Default false (isolated one-shot). Opt in only when the user explicitly wants Codex to see the full conversation; it costs Codex tokens to read.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: backgroundFlagText("sessionId"),
					default: false,
				}),
			),
		}),
		renderCall(args, theme, _context) {
			// Show RESOLVED model/reasoning/sandbox (config defaults applied) so
			// the row identifies what will actually run, not just explicit args.
			const cfg = loadConfig();
			const model = (args.model as string | undefined)?.trim() || cfg.defaultModel;
			const reasoningArg = (args.thinking ?? args.reasoningEffort) as string | undefined;
			const reasoning: ReasoningEffort = isReasoningEffort(reasoningArg)
				? reasoningArg
				: cfg.defaultReasoning;
			const sandbox: SandboxMode = isSandboxMode(args.sandbox) ? args.sandbox : cfg.defaultSandbox;
			const isContinue = typeof args.sessionId === "string" && CODEX_SESSION_ID_RE.test(args.sessionId);

			const tags: string[] = [`model=${model}`, `reasoning=${reasoning}`, `sandbox=${sandbox}`];
			if (isContinue) tags.push("continue");
			if (args.includeContext) tags.push("context=full");
			if (args.background) tags.push("bg");

			let text = theme.fg("mdLink", theme.bold("AskCodex "));
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
			const d = result.details as CodexDetails | undefined;
			if (isPartial) {
				const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
				return new Text(theme.fg("mdLink", "◉ AskCodex ") + theme.fg("muted", status), 0, 0);
			}

			const body = result.content[0]?.type === "text" ? result.content[0].text : "";
			const errored = d?.exitCode !== 0 || !!d?.aborted || !!d?.timedOut;

			let text = errored
				? theme.fg("error", "✗ AskCodex error")
				: theme.fg("mdLink", "✓ AskCodex");

			const rTags: string[] = [];
			if (d?.resolvedModel || d?.model) rTags.push(`model=${d?.resolvedModel ?? d?.model}`);
			if (d?.reasoning) rTags.push(`reasoning=${d.reasoning}`);
			if (d?.sandbox) rTags.push(`sandbox=${d.sandbox}`);
			if (d?.includeContext) rTags.push("context=full");
			if (rTags.length) text += ` ${theme.fg("accent", `[${rTags.join(", ")}]`)}`;
			if (d?.durationMs) text += ` ${theme.fg("dim", `${(d.durationMs / 1000).toFixed(1)}s`)}`;

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
			// Circular-delegation guard (best-effort). This extension registers
			// NO provider, so the check only fires if a future codex-as-provider
			// extension registers a provider literally named codex/openai.
			if (ctx.model?.provider === "codex" || ctx.model?.provider === "openai") {
				return {
					content: [
						{
							type: "text",
							text: "Error: AskCodex cannot be used when the active provider is already codex/OpenAI — you're already running through it.",
						},
					],
					details: {
						...emptyDetails(null, null),
						exitCode: 1,
						stderr: "circular delegation blocked",
					},
				};
			}

			if (!available) {
				return {
					content: [
						{
							type: "text",
							text: `Error: codex CLI not found at "${binary}". Install it (npm install -g @openai/codex) or set CODEX_BIN to its path.`,
						},
					],
					details: { ...emptyDetails(null, null), exitCode: 1 },
				};
			}

			const config = loadConfig();
			const requestedModel = (params.model as string | undefined) ?? config.defaultModel;
			// Defensive: reject leading-dash model values that could misbind
			// on codex's arg parser when spliced as the `-m` value. Same
			// threat model as SESSION_ID_RE — a leading-dash value can't be a
			// model id, so refuse it instead of letting it reach argv. Checks
			// the EFFECTIVE model (config default included), not just the param.
			if (requestedModel.trim().startsWith("-")) {
				return {
					content: [
						{
							type: "text",
							text: `model value "${requestedModel}" starts with "-" — not a valid model id. Use a friendly alias (e.g. "full", "mini", "astra", "gpt") or a known slug (e.g. "gpt-6.1-sol").`,
						},
					],
					details: { ...emptyDetails(requestedModel, null), exitCode: 1 },
				};
			}
			const resolved = resolveCodexModel(requestedModel, discovered);
			if (
				typeof params.thinking === "string" &&
				typeof params.reasoningEffort === "string" &&
				params.thinking !== params.reasoningEffort
			) {
				return {
					content: [
						{
							type: "text",
							text: "thinking and reasoningEffort are synonyms for the same knob - pass one, not both with different values.",
						},
					],
					details: { ...emptyDetails(requestedModel, null), exitCode: 1 },
				};
			}
			const reasoningArg = (params.thinking ?? params.reasoningEffort) as string | undefined;
			const reasoning = isReasoningEffort(reasoningArg)
				? reasoningArg
				: config.defaultReasoning;
			const sandbox = isSandboxMode(params.sandbox) ? params.sandbox : config.defaultSandbox;

			// Fail visibly BEFORE the run when the effort is not on the
			// resolved model's supported ladder (e.g. ultra on gpt-6-luna,
			// which stops at max). Skipped when discovery failed (entry null) —
			// passthrough philosophy, codex reports the mismatch itself.
			if (
				resolved.entry &&
				resolved.entry.efforts.length > 0 &&
				!resolved.entry.efforts.includes(reasoning)
			) {
				return {
					content: [
						{
							type: "text",
							text: `reasoning effort "${reasoning}" is not supported by ${resolved.entry.full}. Supported: ${resolved.entry.efforts.join(", ")}.`,
						},
					],
					details: {
						...emptyDetails(requestedModel, resolved.flagValue, reasoning, sandbox),
						exitCode: 1,
					},
				};
			}

			const start = Date.now();
			const cwd = params.cwd || ctx.cwd || process.cwd();

			// Opt-in full-context export (isolated stays the default).
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
					contextFile = null;
				}
			}

			// Validate cwd up front for a clearer error than codex's.
			try {
				const stat = fs.statSync(cwd);
				if (!stat.isDirectory()) {
					return {
						content: [{ type: "text", text: `cwd is not a directory: ${cwd}` }],
						details: { ...emptyDetails(requestedModel, resolved.flagValue), exitCode: 1 },
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `cwd does not exist: ${cwd}` }],
					details: { ...emptyDetails(requestedModel, resolved.flagValue), exitCode: 1 },
				};
			}

			const timeoutMin = params.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN;

			// Continuity: validate sessionId (Codex ids are UUIDs) before
			// threading it into the resume positional. A leading-dash value
			// could misbind on codex's arg parser.
			const rawSessionId = params.sessionId;
			const isContinuation =
				typeof rawSessionId === "string" &&
				rawSessionId.length > 0 &&
				CODEX_SESSION_ID_RE.test(rawSessionId);

			// Build argv via the shared peer adapter. `codex exec [--json] [opts]
			// "<prompt>"` for fresh, `codex exec resume [opts] <sessionId>
			// "<prompt>"` for continued. The prompt travels as the trailing
			// positional (codex's documented interface); stdin is ignored.
			const args = buildCodexArgs({
				model: resolved.flagValue,
				reasoning,
				sandbox,
				cwd,
				addDir: contextFile ? askContextDir() : null,
				sessionId: isContinuation ? (rawSessionId as string) : undefined,
				extraArgs: extraArgs(),
				prompt: effectivePrompt,
			});

			const details: CodexDetails = {
				model: requestedModel,
				resolvedModel: resolved.flagValue,
				reasoning,
				sandbox,
				sessionId: isContinuation ? (rawSessionId as string) : null,
				includeContext: contextFile !== null,
				exitCode: 0,
				aborted: false,
				timedOut: false,
				durationMs: 0,
				usage: null,
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
					workdir: cwd,
					timeoutMin,
					startAt: start,
					details,
					contextFile,
					modelLabel: resolved.flagValue ?? requestedModel,
				});
			}

			try {
				const outcome = await runCodexProcess({
					binary,
					args,
					workdir: cwd,
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

				// Filter noise from stderr (codex prints "Reading additional
				// input from stdin..." and PATH warnings that aren't errors).
				details.stderr = outcome.stderrClean;
				details.exitCode = outcome.exitCode;
				details.aborted = outcome.aborted;
				details.timedOut = outcome.timedOut;
				details.durationMs = Date.now() - start;

				const finalText = shapeFinalText(details, outcome, timeoutMin);

				if (outcome.aborted || outcome.timedOut || outcome.exitCode !== 0) {
					return { content: [{ type: "text", text: finalText }], details };
				}

				// Clear the last partial status line so the running preview
				// doesn't linger under the final answer.
				onUpdate?.({
					content: [{ type: "text", text: "" }],
					details: { ...details },
				});

				return {
					content: [{ type: "text", text: finalText }],
					details,
				};
			} catch (err) {
				details.stderr = err instanceof CodexSpawnError ? err.stderrClean : "";
				details.durationMs = Date.now() - start;
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `failed to run codex: ${msg}` }],
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
	// --- /codex-stop: kill a background run --------------------------------

	pi.registerCommand("codex-stop", {
		description: "Stop a background AskCodex run (id prefix, or the only running one). Usage: /codex-stop [runId]",
		handler: async (args, ctx) => {
			const message = await stopBackground(args ?? "");
			if (ctx.hasUI) ctx.ui.notify(message, "info");
		},
	});

	const startBackgroundRun = (o: {
		summary: string;
		binary: string;
		args: string[];
		workdir: string;
		timeoutMin: number;
		startAt: number;
		details: CodexDetails;
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
						text: `background refused: ${msg}. Use blocking (omit background) or free a slot with /codex-stop.`,
					},
				],
				details: { ...o.details },
			};
		}
		const runId = run.runId;
		const cleanupStaging = () => {
			// The context file must outlive the execute() return in
			// background mode: codex reads it mid-run.
			if (o.contextFile) {
				try {
					fs.unlinkSync(o.contextFile);
				} catch {}
			}
		};
		cleanups.set(runId, cleanupStaging);
		void runCodexProcess({
			binary: o.binary,
			args: o.args,
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
				// The settle latch makes /codex-stop and shutdown win races
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
					sendWake({ toolLabel: "Codex", runId, ok: false, elapsedS, error: `timeout after ${o.timeoutMin}m.${partial}`, handle });
				} else if (outcome.exitCode !== 0) {
					const reason = o.details.stderr.trim().slice(0, 400) || `exit status ${outcome.exitCode}`;
					sendWake({ toolLabel: "Codex", runId, ok: false, elapsedS, error: reason, handle });
				} else {
					sendWake({ toolLabel: "Codex", runId, ok: true, elapsedS, handle }, finalText);
				}
			})
			.catch((err) => {
				kills.delete(runId);
				const msg = err instanceof Error ? err.message : String(err);
				// Settle first: a /codex-stop that won the race owns the wake.
				const settled = registry.settle(runId, { status: "failed", error: msg });
				if (!settled) return;
				sendWake({ toolLabel: "Codex", runId, ok: false, error: `failed to run codex: ${msg}` });
			})
			.finally(() => {
				cleanups.delete(runId);
				cleanupStaging();
			});
		return {
			content: [
				{
					type: "text",
					text: `Background run ${runId} started (model=${o.modelLabel}). The result arrives as a message when codex finishes; the resume handle (sessionId) comes with it. Do not poll. Continue with other work or end the turn.`,
				},
			],
			details: { ...o.details },
		};
	};
}
