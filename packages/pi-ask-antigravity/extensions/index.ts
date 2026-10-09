/**
 * AskAntigravity — delegate a self-contained sub-task to Google Antigravity's
 * `agy` CLI (the CLI for Gemini). The AskClaude-style delegation pattern,
 * pointed at Gemini via agy.
 *
 * One self-contained tool. Spawns `agy -p`, streams its stdout as partial
 * output, returns the final response. agy runs its OWN tool loop (read,
 * write, edit, exec) inside the workspace.
 *
 * Model aliases: friendly names resolve to the exact `agy models` string.
 *   "flash"            -> latest Flash, default tier (config)
 *   "flash high"       -> latest Flash, high thinking
 *   "pro"              -> latest Pro, default tier (config)
 *   "3.5 flash low"    -> pinned version + tier
 *   "Gemini 3.5 Flash (Medium)" -> exact passthrough
 *
 * Config: ~/.pi/agent/ask-antigravity.json (global) merged over
 *         .pi/ask-antigravity.json (project). Editable via /agy.
 *
 * Two modes (agent decides per call):
 *   - omit conversationId  -> one-shot, agy starts fresh
 *   - pass conversationId   -> resume that agy conversation (full context)
 * The id is discovered on fresh runs by snapshotting agy's conversations dir
 * before spawn and diffing after (agy -p never prints it). This is the one
 * technique borrowed from antigravity-acp's scan.ts.
 *
 * Env:  AGY_BIN (binary path), AGY_EXTRA_ARGS (extra args; whitespace-split,
 *       so values containing spaces are not supported).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentToolResult,
	buildSessionContext,
	getAgentDir,
	getSettingsListTheme,
	keyHint,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { contentText } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	BackgroundRunRegistry,
	backgroundFlagText,
	buildAgyArgs,
	buildFinalPrompt,
	compareVersionsDesc,
	CONVERSATIONS_DIR,
	CONV_ID_RE,
	configPaths,
	createStopHandler,
	createWakeSender,
	DEFAULT_LINE_BUF_MAX_CHARS,
	filterHiddenModels,
	levelToTier,
	loadLayeredRaw,
	mergeCatalog,
	newConversationId,
	parseModelLine,
	resolveAgyModel,
	RunSpawnError,
	runProcess,
	saveLayeredConfig,
	snapshotConversations,
	summarizePrompt,
	tryReadJson,
	type Mode,
	type ModelEntry,
	type ResolvedModel,
	type SaveResult,
	type ThinkingTier,
} from "@estebanforge/pi-ask-shared";

// --- Constants -------------------------------------------------------------

const DEFAULT_TIMEOUT_MIN = 10;
const STATUS_INTERVAL_MS = 1000;
const STATUS_TAIL_CHARS = 160;
const DISCOVERY_TIMEOUT_MS = 8_000;
const DISCOVERY_POLL_ATTEMPTS = 5;
const DISCOVERY_POLL_MS = 100;

// renderCall / renderResult preview limits (match pi-claude-bridge).
const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

const DEFAULT_MODEL = "flash";
const DEFAULT_THINKING = "medium";
// Default on: without --dangerously-skip-permissions, any run_command hangs in
// non-interactive -p mode (accept-edits auto-approves edits, NOT commands).
const DEFAULT_SKIP_PERMISSIONS = true;

// Per-family fallback tier, the pi->agy tier clamp (levelToTier), the static
// alias overlay, and the line grammar now live in the shared peer adapter
// (pi-ask-shared peers/antigravity.ts) alongside the argv builder and the
// conversation-discovery technique, so pi-antigravity-bridge and pi-unblock
// reuse the exact same resolution contract.

// Mode = which agy tool-loop policy to apply. Distinct from the alias layer.
//   "plan"         → --mode plan     (review-shaped; NOT a security boundary:
//                                      the CLI does not gate writes under
//                                      plan, upstream #1181. The skip-
//                                      permissions flag is still withheld so
//                                      nothing runs auto-approved.)
//   "accept-edits" → --mode accept-edits (agy applies edits)
//
// Note: agy's --sandbox flag is an orthogonal shell-containment setting
// (not an "edit preview" mode), so it is not exposed here. Users who need
// it can pass it via the AGY_EXTRA_ARGS env var.

const AGY_DESCRIPTION = `Delegate a self-contained sub-task to Google Antigravity. agy is the CLI for Gemini, so this tool is reached under three equivalent names the user may use interchangeably: **gemini**, **antigravity**, and **agy**. When the user says "ask gemini", "ask antigravity", "ask agy", or otherwise refers to any of these, call THIS tool. agy runs its OWN tool loop: it can read, write, edit, and execute inside the workspace, then returns its final answer. Use for a second opinion from a different model family, Gemini-specific reasoning, or isolated sub-tasks you do not need to drive step-by-step. Provide a complete, self-contained task description; agy will not see this conversation.

TWO MODES (you choose):
- **One-shot (isolated)**: omit conversationId. agy starts fresh with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the conversationId returned in the PREVIOUS call's details (details.conversationId). agy resumes that conversation with full context intact — use for follow-ups, multi-turn refinement, or when the user says "ask agy to follow up / continue / now do X based on what you just did". Thread the id from each result into the next call.

EXECUTION MODES (param: mode):
- **plan**: agy proposes a plan for review-shaped tasks. NOT a security boundary: the CLI does not gate writes under plan mode (upstream google-antigravity/antigravity-cli#1181, probed 2026-10-07: the write can execute in the same turn). The run additionally stages a temporary restricted agent whose toolset has no file-editing tools, as a damper, and the skip-permissions flag is never passed. Inline the material to review - a plan run cannot fetch it.
- **accept-edits** (default): agy applies edits directly inside the workspace.
- For agy's orthogonal \`--sandbox\` shell-containment flag, set the \`AGY_EXTRA_ARGS=--sandbox\` env var.

COMPACT OUTPUT (param: digest): when true, the prompt is prefixed to request compact digests instead of full file contents. Defaults on for plan, off for accept-edits. Use true whenever you do not need full file payloads (review, exploration, planning).

THINKING LEVEL (params: thinking, effort - SYNONYMS for one knob):
- pi calls it thinking, agy calls it effort. Same thing. Pass ONE of the two.
- Values (pi vocabulary): minimal|low|medium|high|xhigh|max. Clamped to agy's low|medium|high; unknown values fall back to low. "peer review on high thinking" -> thinking: "high".
- An explicit level beats a tier embedded in model ("flash high") and the configured default. Omit both for the configured default.`;

// --- Types -----------------------------------------------------------------

type Family = "flash" | "pro" | "other";

// --- Config ----------------------------------------------------------------

interface Config {
	defaultModel: string;
	defaultThinking: ThinkingTier;
	/** Pass --dangerously-skip-permissions so commands don't hang on an
	 *  unanswerable y/n prompt in non-interactive -p mode. Default true. */
	skipPermissions: boolean;
}

/** Layered config paths: global is ~/.pi/agent (homedir, NOT getAgentDir —
 *  today's shipped resolution for this extension); project is <cwd>/.pi. */
function configPathsFor() {
	return configPaths({
		globalDir: path.join(os.homedir(), ".pi", "agent"),
		projectDir: path.join(process.cwd(), ".pi"),
		fileName: "ask-antigravity.json",
	});
}

function loadConfig(): Config {
	const { merged } = loadLayeredRaw(configPathsFor());

	const thinkingRaw = String(merged.defaultThinking ?? DEFAULT_THINKING).toLowerCase();
	const thinking: ThinkingTier =
		thinkingRaw === "low" || thinkingRaw === "high" ? thinkingRaw : "medium";

	const envPerm = process.env.AGY_SKIP_PERMISSIONS;
	const skipPermissions =
		envPerm !== undefined
			? envPerm === "1" || envPerm.toLowerCase() === "true"
			: merged.skipPermissions === false ? false : DEFAULT_SKIP_PERMISSIONS;

	return {
		defaultModel: String(merged.defaultModel ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
		defaultThinking: thinking,
		skipPermissions,
	};
}

/** Persist a config patch via the shared all-or-nothing router: if any
 *  patched key is already project-defined, the whole patch goes to the
 *  project file (it shadows global on load). Atomic write inside. */
function saveConfig(patch: Partial<Config>): SaveResult {
	return saveLayeredConfig(configPathsFor(), patch as Record<string, unknown>);
}

// --- Prompt assembly: shared peer adapter ----------------------------------
// The plan-mode guards (PLAN_HEADLESS_GUARD / AGENT_REVIEW_GUARD) and the
// prompt assembler (buildFinalPrompt) live in pi-ask-shared
// (peers/antigravity.ts) so the bridge's ask-tool and pi-unblock consults
// inherit the identical guard discipline.
export { AGENT_REVIEW_GUARD, PLAN_HEADLESS_GUARD } from "@estebanforge/pi-ask-shared";

// --- Plan-mode reviewer agent ----------------------------------------------

const ASK_AGENT_PREFIX = "pi-bridge-ask-";
const ASK_AGENT_TOOLS = ["view_file", "run_command"];

/** Temp agent dirs share the ~/.gemini/config/agents discovery root; the
 *  AGY_AGENTS_ROOT override exists for tests and sandboxes. */
export function askAgentsRoot(): string {
	return process.env.AGY_AGENTS_ROOT ?? path.join(os.homedir(), ".gemini", "config", "agents");
}

/** agent.md for the plan-mode reviewer. The tools list is a damper, not
 *  enforcement: with no file-editing tool present the model cannot emit an
 *  edit call through the agent toolset, but the CLI does not enforce
 *  review-only (upstream #1181 - writes bypass the permission system and
 *  the toolset is not honored reliably on 1.3.x). Prefer view_file for
 *  reads here too. Never add a write-capable tool. */
export function reviewerAgentMd(name: string): string {
	return [
		"---",
		`name: ${name}`,
		"description: Temporary Pi plan-mode reviewer",
		"mainAgent: true",
		"subagent: false",
		"model: inherit",
		"excludeDefaultComponents: true",
		"inheritCustomizations: false",
		"inheritMcp: false",
		"commandExecutionPolicy: auto",
		"tools:",
		...ASK_AGENT_TOOLS.map((t) => `  - ${t}`),
		"skills: []",
		"rules: []",
		"agents: []",
		"mcpServers: []",
		"---",
		"",
		"You are a strict read-only code reviewer. Review, analyze, and plan; never modify anything.",
		"",
	].join("\n");
}

/** Stage one unique reviewer agent (agent.md + pid marker) under root. Same
 *  hygiene doctrine as the web delegates: nonce-named, cleaned in finally,
 *  orphans swept by pid marker at registration. */
export function stageReviewerAgent(root: string): { name: string; dir: string } {
	fs.mkdirSync(root, { recursive: true });
	const name = `${ASK_AGENT_PREFIX}${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(dir, "agent.md"), reviewerAgentMd(name), { mode: 0o600 });
	fs.writeFileSync(path.join(dir, ".pid"), `${process.pid}\n`, { mode: 0o600 });
	return { name, dir };
}

/** Remove leftover reviewer agent dirs: dead-pid markers always, marker-less
 *  dirs only after the grace period (a live sibling may sit between mkdir and
 *  its pid write). Never touches foreign agent dirs. */
export function sweepStaleAskAgents(
	root: string = askAgentsRoot(),
	now = Date.now(),
	prefix: string = ASK_AGENT_PREFIX,
): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return; // no agents dir yet: nothing to sweep
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const dir = path.join(root, entry);
		try {
			let stale: boolean;
			try {
				const pid = Number.parseInt(fs.readFileSync(path.join(dir, ".pid"), "utf8").trim(), 10);
				stale = Number.isInteger(pid) && pid > 0 ? !pidAlive(pid) : now - fs.statSync(dir).mtimeMs > 24 * 60 * 60 * 1000;
			} catch {
				stale = now - fs.statSync(dir).mtimeMs > 24 * 60 * 60 * 1000;
			}
			if (stale) fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// vanished mid-sweep: nothing to remove
		}
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// --- Model parsing + alias resolution: shared peer adapter ---------------
// parseModelLine, the tier ladder, and resolveModel (family/version/tier
// resolution incl. the static sonnet/opus overlay) live in pi-ask-shared
// (peers/antigravity.ts); discoverModels below feeds them the live catalog.
// --- agy process helpers ---------------------------------------------------

function resolveAgy(): string {
	return process.env.AGY_BIN || "agy";
}

// Defer to pi-antigravity-bridge when it is installed: the bridge provides BOTH
// the streaming antigravity provider AND the AskAntigravity tool (same shape as
// pi-claude-bridge). Registering the tool here too would create a duplicate.
//
// Detection does NOT rely on module resolution: pi loads each package with a
// separate module root (docs/packages.md), so require.resolve from here never
// reaches a sibling package. Instead we check:
//   1. An in-process Symbol.for flag the bridge sets at its load (fast path
//      when the bridge loaded earlier this session).
//   2. The bridge's package.json at pi's documented install locations
//      (~/.pi/agent/npm|git/... and project .pi/npm|git/...).
//
// Coverage: (2) is order-independent for npm/git installs - installation is a
// fact on disk. For LOCAL/source installs (`pi install <path>`) the package
// lives at its original checkout, not under .pi/npm|git/, so (2) sees nothing;
// there only (1) helps, and only if the bridge loads first. Recommendation for
// dev with both repos checked out side-by-side: install the bridge first so it
// is earlier in settings.json (pi loads extensions in that order). If the
// clash still occurs, both tools are functionally identical, so the only
// symptom is a duplicate-name TUI warning - not broken behavior.
const BRIDGE_FLAG = Symbol.for("pi-antigravity-bridge:active");

function bridgeInstallPaths(): string[] {
	const npmPkg = path.join("@estebanforge", "pi-antigravity-bridge", "package.json");
	const gitPkg = path.join("EstebanForge", "pi-antigravity-bridge", "package.json");
	const home = os.homedir();
	const cwd = process.cwd();
	return [
		path.join(home, ".pi", "agent", "npm", "node_modules", npmPkg),
		path.join(cwd, ".pi", "npm", "node_modules", npmPkg),
		path.join(home, ".pi", "agent", "git", "github.com", gitPkg),
		path.join(cwd, ".pi", "git", "github.com", gitPkg),
	];
}

const isBridgeInstalled = (): boolean => {
	if ((globalThis as Record<symbol, unknown>)[BRIDGE_FLAG]) return true;
	return bridgeInstallPaths().some((p) => {
		try {
			return fs.existsSync(p);
		} catch {
			return false;
		}
	});
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Query `agy models`. Returns [] on any failure (non-fatal). */
async function discoverModels(binary: string): Promise<ModelEntry[]> {
	try {
		const text = await new Promise<string>((resolve, reject) => {
			const proc = spawn(binary, ["models"], {
				stdio: ["ignore", "pipe", "ignore"],
				shell: false,
			});
			// Decode at the stream level so multibyte codepoints split across
			// pipe chunks don't corrupt.
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
			// Bound the spawn so a hung agy (auth prompt, network stall) can't
			// block extension load indefinitely.
			const watchdog = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
				finish("");
			}, DISCOVERY_TIMEOUT_MS);
		});
		return filterHiddenModels(
			text.split("\n").map(parseModelLine).filter((e): e is ModelEntry => e !== null),
		);
	} catch {
		return [];
	}
}

function extraArgs(): string[] {
	const raw = process.env.AGY_EXTRA_ARGS;
	return raw ? raw.split(/\s+/).filter((s) => s.length > 0) : [];
}

// --- Conversation discovery: shared peer adapter ---------------------------
// The .db snapshot / new-id pick / /proc FD disambiguation technique lives
// in pi-ask-shared (peers/antigravity.ts): snapshotConversations +
// newConversationId. CONVERSATIONS_DIR (env-overridable) is exported there.
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
	return path.join(path.dirname(getAgentDir()), "extensions-data", "estebanforge", "pi-ask-antigravity");
}

// --- Extension -------------------------------------------------------------

interface AgyDetails {
	model: string | null;
	resolvedModel: string | null;
	thinking: ThinkingTier | null;
	mode: Mode;
	digest: boolean;
	conversationId: string | null;
	includeContext: boolean;
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	// Exit 0 with no answer on stdout (the empty-output failure branch).
	// renderResult flips to the error glyph on it.
	empty?: boolean;
	durationMs: number;
	stderr: string;
}


// --- Background-mode plumbing ----------------------------------------------
// Shared shape for both call styles: blocking awaits it, background lets it
// run detached and pushes the outcome through the wake sender on close.

const STDOUT_BUF_MAX_CHARS = 1_000_000;

/** Spawn failure (binary vanished between resolve and spawn). */
class AgySpawnError extends Error {}

interface ProcessRunOptions {
	binary: string;
	args: string[];
	workdir: string;
	timeoutMin: number;
	startAt: number;
	/** Mutated in place: conversationId discovery, stderr, durationMs. */
	details: AgyDetails;
	isContinuation: boolean;
	snapshot: ReturnType<typeof snapshotConversations> | null;
	/** Blocking passes pi's per-run signal; background passes none on purpose: a later Esc must not kill a detached run. */
	signal?: AbortSignal;
	/** Blocking only: throttled progress partials. */
	onPartial?: (text: string) => void;
	/** Background only: hands over the tree-kill switch plus the live child
	 *  handle (pid for the FD-disambiguation poll) as soon as the child exists. */
	onSpawn?: (kill: () => void, proc: ChildProcess) => void;
}

interface ProcessRunOutcome {
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	/** Full stdout, trimmed. Empty means the headless auto-deny failure mode. */
	answerText: string;
}

/** Tool-result shape this extension returns; keeps the background helper's literals narrow. */
interface AskToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: AgyDetails;
}

/**
 * Spawns agy -p, accumulates stdout, runs conversation-id discovery (during
 * the run via the /proc FD resolver, then the post-exit scan fallback), and
 * resolves when the process tree closes.
 */
async function runAgyProcess(opts: ProcessRunOptions): Promise<ProcessRunOutcome> {
	const { binary, args, workdir, timeoutMin, startAt, details, isContinuation, snapshot, signal, onPartial, onSpawn } = opts;
	let out = "";

	const statusInterval = onPartial
		? setInterval(() => {
				const elapsed = Math.floor((Date.now() - startAt) / 1000);
				const tail = out.slice(-STATUS_TAIL_CHARS);
				const text = tail ? `(running ${elapsed}s)\n…${tail}` : `(running ${elapsed}s)`;
				onPartial(text);
			}, STATUS_INTERVAL_MS)
		: null;

	try {
		// Concurrent bind poll: while agy is ALIVE, the pid-based /proc FD
		// resolver can disambiguate when a concurrent agy also drops a new
		// .db. runProcess hands us the kill switch plus the spawned process
		// through onSpawn; the pid is only useful while the tree lives, and
		// the post-exit scan below is the fallback once it is gone.
		let bindDuringRun: Promise<void> = Promise.resolve();

		const outcome = await runProcess({
			binary,
			args,
			cwd: workdir,
			timeoutMs: timeoutMin * 60_000,
			signal,
			// Raw chunks stream live so the status tail matches the old
			// during-run accumulation. The 1MB valve lives in runProcess for
			// stdoutRaw; this accumulator applies the original's own valve
			// (past 1MB, keep the last 100k) so a pathological stream cannot
			// balloon memory through the live tail.
			onChunk: (chunk) => {
				out += chunk;
				if (out.length > DEFAULT_LINE_BUF_MAX_CHARS) out = out.slice(-100_000);
			},
			onSpawn: (kill, proc) => {
				// Hand the kill switch to the background registry first, then
				// start the bind poll against the live pid.
				onSpawn?.(kill, proc);
				if (!isContinuation && snapshot && proc.pid) {
					bindDuringRun = (async () => {
						for (let attempt = 0; attempt < DISCOVERY_POLL_ATTEMPTS; attempt++) {
							if (details.conversationId) return;
							if (proc.exitCode !== null) return; // agy gone: scan useless now
							const found = newConversationId(CONVERSATIONS_DIR, snapshot, {
								pid: proc.pid,
							});
							if (found) {
								details.conversationId = found;
								return;
							}
							await sleep(DISCOVERY_POLL_MS);
						}
					})().catch(() => {
						/* best-effort: a bind error must never fail an otherwise-OK turn */
					});
				}
			},
		});

		if (statusInterval) clearInterval(statusInterval);

		// Let the during-run bind poll finish (it bails immediately once agy
		// has exited, so this rarely blocks).
		await bindDuringRun;

		// stderr feeds notes and wake messages, not forensics; runProcess
		// applies the same 64k cap the inline accumulator used to.
		details.stderr = outcome.stderr;
		details.exitCode = outcome.exitCode;
		details.aborted = outcome.aborted;
		details.timedOut = outcome.timedOut;
		details.durationMs = Date.now() - startAt;

		// For a fresh run, discover the conversation id agy just created
		// (agy -p never prints it). Retry briefly since agy may flush its
		// SQLite DB a moment after the process closes. A continuation run
		// reuses the provided id (already set on details).
		if (!isContinuation && !details.conversationId && snapshot) {
			for (let attempt = 0; attempt < DISCOVERY_POLL_ATTEMPTS; attempt++) {
				const found = newConversationId(CONVERSATIONS_DIR, snapshot);
				if (found) {
					details.conversationId = found;
					break;
				}
				await sleep(DISCOVERY_POLL_MS);
			}
		}

		return { ...outcome, answerText: out.trim() };
	} catch (err) {
		// Preserve the extension's spawn-error contract (fixed message).
		if (err instanceof RunSpawnError) throw new AgySpawnError("failed to spawn agy");
		throw err;
	} finally {
		if (statusInterval) clearInterval(statusInterval);
	}
}

/**
 * Builds the user/model-facing answer text for every terminal outcome.
 * Pure except the empty-output marker it stamps on details.
 */
function shapeFinalText(details: AgyDetails, outcome: ProcessRunOutcome, timeoutMin: number): string {
	const text = outcome.answerText;

	// Aborted: a distinct result so the caller knows it was cancelled, not a silent success.
	if (outcome.aborted) {
		return text ? `agy was aborted. Partial output:\n\n${text}` : "agy was aborted before producing output.";
	}

	// Timeout: distinct from a genuine non-zero exit (the watchdog
	// killed the tree because the configured cap elapsed).
	if (outcome.timedOut) {
		const note = `agy exceeded the ${timeoutMin}m timeout and was killed`;
		return text ? `${text}\n\n[${note}]` : note;
	}

	// Non-zero exit: surface the failure even when partial text exists.
	if (outcome.exitCode !== 0) {
		const note = details.stderr.trim()
			? `agy exited with status ${outcome.exitCode}: ${details.stderr.trim()}`
			: `agy exited with status ${outcome.exitCode}`;
		return text ? `${text}\n\n[${note}]` : note;
	}

	// Exit 0 with nothing on stdout is still a failure for the
	// caller: headless agy auto-denies a permission-gated tool call
	// (e.g. the command gate in plan mode), prints the reason only to
	// stderr, and ends cleanly. Falling through to the success path
	// here returned just the conversation footer, which read as an
	// empty success (silent-failure bug found 2026-09-25).
	if (!text) {
		details.empty = true;
		const note = [
			"agy exited cleanly but produced no output.",
			details.stderr.trim() ? `stderr: ${details.stderr.trim()}` : null,
			"Common cause: a tool call needed a permission that headless mode cannot prompt for (typically the command gate in plan mode), so it was auto-denied and the turn ended with no answer. Recovery: retry in plan mode with all needed content inlined in the prompt - plan runs cannot fetch it, commands are denied. Or rerun outside plan mode with skipPermissions, or add your own permissions.allow rules in ~/.gemini/antigravity-cli/settings.json.",
		]
			.filter(Boolean)
			.join(" ");
		return note;
	}

	// Success. Conversation footer lets the orchestrating model thread the id.
	const footer = details.conversationId
		? `\n\n[agy conversationId: ${details.conversationId} — pass as conversationId to continue this conversation]`
		: "";

	return text + footer;
}

export default async function (pi: ExtensionAPI) {
	// If pi-antigravity-bridge is installed, it owns the AskAntigravity tool
	// (and the provider). Stay silent and register nothing to avoid a
	// duplicate-tool clash. Without the bridge, this extension behaves as
	// before (standalone tool).
	if (isBridgeInstalled()) return;

	// Orphan sweep for the plan-mode reviewer agents (SIGKILL can skip the
	// run's finally): same pid-marker doctrine as the bridge's web delegates.
	try {
		sweepStaleAskAgents();
	} catch {
		// a sweep failure must never block registration
	}

	const binary = resolveAgy();
	// Discovered once at load; frozen for the session. Run /reload after an
	// `agy update` to refresh. Failure is non-fatal: resolveModel falls back
	// to passthrough so exact slugs typed by the user still work. The static
	// alias overlay (sonnet / opus) is merged on top so those
	// aliases resolve even when agy doesn't surface them in the live catalog.
	const discovered = mergeCatalog(await discoverModels(binary).catch(() => []));

	// --- Background-run state (one set per extension load) -------------------
	// Pi wipes module state on /new, /resume, /fork and /reload: an in-flight
	// background run is killed and its result is never delivered. Accepted
	// trade-off, documented in the README.
	const registry = new BackgroundRunRegistry({ toolName: "ask-antigravity" });
	const kills = new Map<string, () => void>();
	// Staged-artifact cleanup (contextFile + reviewer agent dir), keyed by run:
	// the session_shutdown backstop runs these when a hard exit would skip the
	// close-path finally.
	const cleanups = new Map<string, () => void>();
	// One background run per conversationId at a time: two runs resuming the
	// same conversation interleave their turns inside agy's SQLite state.
	const busyHandles = new Set<string>();
	const sendWake = createWakeSender(pi, {
		customType: "ask-antigravity-result",
		isDisposed: () => registry.isDisposed(),
	});
	const stopBackground = createStopHandler(registry, {
		kill: (run) => kills.get(run.runId)?.(),
		onStopped: (run) =>
			sendWake({
				toolLabel: "agy",
				runId: run.runId,
				ok: false,
				elapsedS: Math.round((Date.now() - run.startedAt) / 1000),
				error: "stopped via /agy-stop",
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

	// --- /agy: view / change default model + thinking ---------------------

	// Friendly model options offered in the picker. Exact strings also work
	// if typed, but the menu presents the common aliases.
	const MODEL_OPTIONS = ["flash", "pro", "gemini"];
	const THINKING_OPTIONS: ThinkingTier[] = ["low", "medium", "high"];

	pi.registerCommand("agy", {
		description:
			"AskAntigravity config: show status, or open the model/thinking picker. Usage: /agy",
		handler: async (_args, ctx) => {
			const config = loadConfig();

			// Headless / RPC fallback: print a status snapshot.
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					[
						`AskAntigravity config`,
						`  defaultModel:    ${config.defaultModel}`,
						`  defaultThinking: ${config.defaultThinking}`,
						`  permissions:     ${config.skipPermissions ? "auto-approved" : "prompt"}`,
						`  resolved:        ${resolveAgyModel(config.defaultModel, discovered, config.defaultThinking)?.model ?? "(agy default)"}`,
						``,
						`Edit: ~/.pi/agent/ask-antigravity.json`,
					].join("\n"),
					"info",
				);
				return;
			}

			// Resolve the display string for the current default model.
			const currentResolved =
				resolveAgyModel(config.defaultModel, discovered, config.defaultThinking)?.model ?? config.defaultModel;

			const items: SettingItem[] = [
				{
					id: "defaultModel",
					label: "Default model",
					description:
						"Friendly alias resolved to the latest matching agy model. 'flash' = latest Flash, 'pro' = latest Pro, 'gemini' = latest Flash.",
					currentValue: `${config.defaultModel} → ${currentResolved}`,
					values: MODEL_OPTIONS.map((m) => {
						const r = resolveAgyModel(m, discovered, config.defaultThinking)?.model ?? m;
						return `${m} → ${r}`;
					}),
				},
				{
					id: "defaultThinking",
					label: "Default thinking",
					description:
						"Thinking tier used when the model alias doesn't name one. Pro has no Medium; it falls back to the nearest (Low or High).",
					currentValue: config.defaultThinking,
					values: THINKING_OPTIONS,
				},
				{
					id: "permissions",
					label: "Permissions",
					description:
						"auto-approved: --dangerously-skip-permissions (required so run_command doesn't hang in -p mode). prompt: agy asks y/n (hangs non-interactively).",
					currentValue: config.skipPermissions ? "auto-approved" : "prompt",
					values: ["auto-approved", "prompt"],
				},
			];

			const pending: Partial<Config> = {};

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(
					new Text(theme.fg("accent", theme.bold("AskAntigravity defaults")), 1, 1),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 4, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						if (id === "defaultModel") {
							// Value is "alias → resolved"; keep the alias part.
							const alias = newValue.split("→")[0].trim();
							pending.defaultModel = alias;
						} else if (id === "defaultThinking") {
							pending.defaultThinking = newValue as ThinkingTier;
						} else if (id === "permissions") {
							pending.skipPermissions = newValue === "auto-approved";
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
					? "(written to project .pi/ask-antigravity.json — it shadows global)"
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

	// Model param: free string (friendly alias OR exact). Previously this
	// was a StringEnum built from the live catalog; that made tiered/pinned
	// aliases ("flash high", "3.5 flash") fail AJV validation before
	// resolveModel ever saw them. Type.String() lets the resolver handle
	// every documented form and falls back to agy for unknown slugs.
	const modelParam = Type.Optional(
		Type.String({
			description:
				"Model alias or exact id. Friendly: 'flash' (latest Flash, prefers the gemini-flash-latest alias), 'pro' (latest Pro, prefers gemini-pro-latest), 'gemini' (=flash). Add a tier: 'flash high', 'pro low'. Pin a version: '3.5 flash'. Exact: 'Gemini 3.5 Flash (Medium)'. Omit for the configured default.",
		}),
	);

	pi.registerTool({
		name: "AskAntigravity",
		label: "Ask Antigravity",
		description: AGY_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained task for agy. Include all context agy needs; it cannot see this conversation.",
			}),
			cwd: Type.Optional(
				Type.String({
					description: "Absolute workspace path agy runs in. Defaults to the current project root.",
				}),
			),
			model: modelParam,
			thinking: Type.Optional(
				Type.String({
					description:
						"Thinking level (= agy effort tier). pi vocabulary: minimal|low|medium|high|xhigh|max, clamped to agy's low|medium|high. Overrides a tier embedded in `model`. Omit for the configured default.",
				}),
			),
			effort: Type.Optional(
				Type.String({
					description:
						"Alias for `thinking` (agy's own name for the same knob). Pass ONE of the two; different values on both is an error.",
				}),
			),
			mode: Type.Optional(
				Type.Union(
					[
						Type.Literal("plan"),
						Type.Literal("accept-edits"),
					],
					{
						description:
							"agy execution mode. 'plan' = plan-shaped run: the CLI does not enforce review-only (see the tool description); the staged reviewer agent's toolset omits file-editing tools as a damper, and the skip-permissions flag is never passed. 'accept-edits' = agy applies edits directly (--mode accept-edits, default). For agy's orthogonal --sandbox shell-containment flag, set the AGY_EXTRA_ARGS env var.",
						default: "accept-edits",
					},
				),
			),
			digest: Type.Optional(
				Type.Boolean({
					description:
						"Request compact digests instead of full file contents. When true, the prompt is prefixed with '(Use compact digests, not full file contents.)'. Defaults on for plan, off for accept-edits.",
				}),
			),
			conversationId: Type.Optional(
				Type.String({
					description:
						"Omit for a one-shot (agy starts fresh). To CONTINUE a previous agy conversation with its context intact, pass the conversationId returned in that call's details. agy resumes that conversation.",
				}),
			),
			timeoutMinutes: Type.Optional(
				Type.Number({
					description: `Hard cap on the agy run in minutes. Default ${DEFAULT_TIMEOUT_MIN}.`,
				}),
			),
			includeContext: Type.Optional(
				Type.Boolean({
					description:
						"When true, export the current pi conversation (resolved, as markdown) to a temp file inside the workspace and tell agy to read it first. Default false (isolated one-shot). Opt in only when the user explicitly wants agy to see the full conversation; it costs agy tokens to read.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: backgroundFlagText("conversationId"),
					default: false,
				}),
			),
		}),
		renderCall(args, theme, _context) {
			// Show RESOLVED model/thinking/mode (config defaults applied) so the
			// row identifies what will actually run, not just explicit args.
			// agy folds the thinking tier into the model alias or --effort; we
			// surface the resolved tier separately for identification.
			const cfg = loadConfig();
			const requestedModel = (args.model as string | undefined)?.trim() || cfg.defaultModel;
			const thinkingArg = (args.thinking as string | undefined) ?? (args.effort as string | undefined);
			const resolved: ResolvedModel =
				resolveAgyModel(
					requestedModel,
					discovered,
					cfg.defaultThinking,
					thinkingArg ? levelToTier(thinkingArg) : undefined,
				) ?? { model: requestedModel };
			const thinking: ThinkingTier = resolved.effort ?? cfg.defaultThinking;
			const mode: Mode = (args.mode as Mode | undefined) ?? "accept-edits";
			const useDigest = typeof args.digest === "boolean" ? args.digest : mode === "plan";
			const isContinue =
				typeof args.conversationId === "string" && CONV_ID_RE.test(args.conversationId);

			const tags: string[] = [`model=${resolved.model}`, `thinking=${thinking}`];
			if (mode !== "accept-edits") tags.push(`mode=${mode}`);
			if (useDigest) tags.push("digest");
			if (isContinue) tags.push("continue");
			if (args.includeContext) tags.push("context=full");
			if (args.background) tags.push("bg");

			let text = theme.fg("mdLink", theme.bold("AskAntigravity "));
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
			const d = result.details as AgyDetails | undefined;
			if (isPartial) {
				const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
				return new Text(theme.fg("mdLink", "◉ AskAntigravity ") + theme.fg("muted", status), 0, 0);
			}

			const body = result.content[0]?.type === "text" ? result.content[0].text : "";
			const errored =
		d?.exitCode !== 0 || !!d?.aborted || !!d?.timedOut || !!d?.empty;

			let text = errored
				? theme.fg("error", "✗ AskAntigravity error")
				: theme.fg("mdLink", "✓ AskAntigravity");

			const rTags: string[] = [];
			if (d?.resolvedModel || d?.model) rTags.push(`model=${d?.resolvedModel ?? d?.model}`);
			if (d?.thinking) rTags.push(`thinking=${d.thinking}`);
			if (d?.mode && d.mode !== "accept-edits") rTags.push(`mode=${d.mode}`);
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
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Circular-delegation guard (best-effort). This extension registers
			// NO provider, so the check only fires if a future agy-as-provider
			// extension registers a provider literally named antigravity/agy.
			// Cheap insurance; harmless otherwise.
			if (ctx.model?.provider === "antigravity" || ctx.model?.provider === "agy") {
				return {
					content: [
						{
							type: "text",
							text: "Error: AskAntigravity cannot be used when the active provider is already agy/Antigravity — you're already running through it.",
						},
					],
					details: {
						model: null,
						resolvedModel: null,
						mode: "accept-edits",
						digest: false,
						conversationId: null,
						exitCode: 0,
						aborted: false,
						timedOut: false,
						durationMs: 0,
						stderr: "circular delegation blocked",
					},
				};
			}

			const config = loadConfig();
			const requestedModel = (params.model as string | undefined) ?? config.defaultModel;
			// Defensive: reject leading-dash model values that could misbind
			// on agy's arg parser when spliced as the `--model` value. Same
			// threat model as CONV_ID_RE — a leading-dash value can't be a
			// model id, so refuse it instead of letting it reach argv.
			if (typeof params.model === "string" && params.model.trim().startsWith("-")) {
				return {
					content: [
						{
							type: "text",
							text: `model value "${params.model}" starts with "-" — not a valid model id. Use a friendly alias (e.g. "flash", "pro", "gemini") or a known exact id (e.g. "Gemini 3.5 Flash (Medium)").`,
						},
					],
					details: emptyDetails(requestedModel, null),
				};
			}
			if (
				typeof params.thinking === "string" &&
				typeof params.effort === "string" &&
				params.thinking !== params.effort
			) {
				return {
					content: [
						{
							type: "text",
							text: "thinking and effort are synonyms for the same knob - pass one, not both with different values.",
						},
					],
					details: emptyDetails(requestedModel, null),
				};
			}
			const thinkingArg = (params.thinking as string | undefined) ?? (params.effort as string | undefined);
			const resolved: ResolvedModel =
				resolveAgyModel(
					requestedModel,
					discovered,
					config.defaultThinking,
					thinkingArg ? levelToTier(thinkingArg) : undefined,
				) ?? {
					model: requestedModel,
				};

			const start = Date.now();
			const cwd = params.cwd || ctx.cwd || process.cwd();

			// Validate cwd up front for a clearer error than agy's ENOENT.
			try {
				const stat = fs.statSync(cwd);
				if (!stat.isDirectory()) {
					return {
						content: [{ type: "text", text: `cwd is not a directory: ${cwd}` }],
						details: emptyDetails(requestedModel, resolved.model),
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `cwd does not exist: ${cwd}` }],
					details: emptyDetails(requestedModel, resolved.model),
				};
			}

			const timeoutMin = params.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN;

			// Continuity: if a conversationId is provided AND validates as an agy
			// id (UUID-ish DB stem, never a leading-dash flag), resume it; otherwise
			// snapshot the conversations dir so we can discover the new id agy
			// creates (agy -p never prints it). This is the one mechanism
			// borrowed from antigravity-acp's scan.ts. Validation rejects values
			// that could misbind on agy's arg parser (e.g. --dangerously-skip-
			// permissions passed as the token after --conversation).
			const rawConvId = params.conversationId;
			const isContinuation =
				typeof rawConvId === "string" && rawConvId.length > 0 && CONV_ID_RE.test(rawConvId);
			const snapshot = isContinuation ? null : snapshotConversations(CONVERSATIONS_DIR);

			const mode: Mode = (params.mode as Mode | undefined) ?? "accept-edits";
			// Plan runs stage a restricted reviewer agent: its tools list has NO
			// file-editing tool, a toolset-level damper on edits (the prompt
			// guard alone was observed failing once - a sub-agent still edited
			// files; the CLI itself does not enforce review-only, upstream
			// #1181). Staging failure degrades to the legacy fallback: no agent,
			// no skip flag, the stricter command-forbidding guard.
			let reviewerAgent: { name: string; dir: string } | null = null;
			if (mode === "plan") {
				try {
					reviewerAgent = stageReviewerAgent(askAgentsRoot());
				} catch {
					reviewerAgent = null;
				}
			}
			// digest default: on for plan (review-shaped contexts where full file
			// contents are noise), off for accept-edits (agy applies edits and
			// may need richer context for diffs).
			const useDigest: boolean =
				typeof params.digest === "boolean"
					? params.digest
					: mode === "plan";
			const finalPrompt: string = buildFinalPrompt(
				params.prompt,
				mode,
				useDigest,
				reviewerAgent !== null,
			);

			// Opt-in full-context export (isolated stays the default).
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
					}
				} catch {
					contextFile = null;
				}
			}
			const effectivePrompt = contextFile
				? `The full pi conversation context (as markdown) is at: ${contextFile}\nRead that file first for context, then do the task below.\n\n---\n\n${finalPrompt}`
				: finalPrompt;

			// Build argv via the shared peer adapter (see buildAgyArgs there for
			// the flag-order contract and the fail-closed plan-run rules).
			const args = buildAgyArgs({
				cwd,
				resolved,
				mode,
				reviewerAgentName: reviewerAgent?.name ?? null,
				skipPermissions: config.skipPermissions,
				conversationId: isContinuation ? (rawConvId as string) : null,
				timeoutMinutes: timeoutMin,
				addDirs: contextFile ? [askContextDir()] : [],
				extraArgs: extraArgs(),
				prompt: effectivePrompt,
			});

			const details: AgyDetails = {
				model: requestedModel,
				resolvedModel: resolved.model,
				thinking: resolved.effort ?? config.defaultThinking,
				mode,
				digest: useDigest,
				conversationId: isContinuation ? (rawConvId as string) : null,
				includeContext: contextFile !== null,
				exitCode: 0,
				aborted: false,
				timedOut: false,
				durationMs: 0,
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
					if (reviewerAgent) {
						try {
							fs.rmSync(reviewerAgent.dir, { recursive: true, force: true });
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
					reviewerAgent,
					modelLabel: resolved.model ?? requestedModel,
					isContinuation,
					conversationId: isContinuation ? (rawConvId as string) : undefined,
				});
			}

			// One run per conversationId at a time, blocking included: a blocking
			// resume and a background resume of the same conversation would
			// interleave turns inside agy's session state. Declared out here so
			// the finally can see it; set only when THIS call takes the lock.
			let lockAcquired = false;
			try {
				if (isContinuation && busyHandles.has(rawConvId as string)) {
					if (contextFile) {
						try {
							fs.unlinkSync(contextFile);
						} catch {}
					}
					if (reviewerAgent) {
						try {
							fs.rmSync(reviewerAgent.dir, { recursive: true, force: true });
						} catch {}
					}
					return {
						content: [
							{
								type: "text",
								text: `conversation ${rawConvId} already has a run in flight. Wait for its result, or stop it with /agy-stop.`,
							},
						],
						details: emptyDetails(requestedModel, resolved.model),
					};
				}
				// Track acquisition: the finally must only release a lock THIS call
				// took, never the one held by the run that caused a refusal.
				lockAcquired = isContinuation;
				if (isContinuation) busyHandles.add(rawConvId as string);
				const outcome = await runAgyProcess({
					binary,
					args,
					workdir: cwd,
					timeoutMin,
					startAt: start,
					details,
					isContinuation,
					snapshot,
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

				const finalText = shapeFinalText(details, outcome, timeoutMin);

				if (outcome.aborted || outcome.timedOut || outcome.exitCode !== 0) {
					return { content: [{ type: "text", text: finalText }], details };
				}

				// Exit 0 with no output keeps its dedicated failure result
				// (headless auto-deny); see shapeFinalText for the note.
				if (!outcome.answerText) {
					return { content: [{ type: "text", text: finalText }], details };
				}

				// Success. Clear the last partial status line (claude-bridge
				// idiom) so the running-tail preview doesn't linger under the final
				// answer.
				onUpdate?.({
					content: [{ type: "text", text: "" }],
					details: { ...details },
				});

				return {
					content: [{ type: "text", text: finalText }],
					details,
				};
			} catch (err) {
				details.durationMs = Date.now() - start;
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `failed to run agy: ${msg}` }],
					details,
				};
			} finally {
				if (isContinuation && lockAcquired) busyHandles.delete(rawConvId as string);
				if (contextFile) {
					try {
						fs.unlinkSync(contextFile);
					} catch {}
				}
				if (reviewerAgent) {
					try {
						fs.rmSync(reviewerAgent.dir, { recursive: true, force: true });
					} catch {}
				}
			}
		},
	});
	// --- /agy-stop: kill a background run ----------------------------------

	pi.registerCommand("agy-stop", {
		description: "Stop a background AskAntigravity run (id prefix, or the only running one). Usage: /agy-stop [runId]",
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
		details: AgyDetails;
		contextFile: string | null;
		reviewerAgent: { name: string; dir: string } | null;
		modelLabel: string;
		isContinuation: boolean;
		conversationId?: string;
	}): AskToolResult => {
		registry.sweep();
		// Per-handle lock: two background runs resuming the same conversation
		// would interleave turns inside agy's session state.
		if (o.conversationId && busyHandles.has(o.conversationId)) {
			return {
				content: [
					{
						type: "text",
						text: `background refused: conversation ${o.conversationId} already has a background run. Wait for its wake message, or use blocking mode.`,
					},
				],
				details: { ...o.details },
			};
		}
		if (o.conversationId) busyHandles.add(o.conversationId);
		let run;
		try {
			run = registry.start(summarizePrompt(o.summary));
		} catch (err) {
			if (o.conversationId) busyHandles.delete(o.conversationId);
			if (o.contextFile) {
				try {
					fs.unlinkSync(o.contextFile);
				} catch {}
			}
			if (o.reviewerAgent) {
				try {
					fs.rmSync(o.reviewerAgent.dir, { recursive: true, force: true });
				} catch {}
			}
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text",
						text: `background refused: ${msg}. Use blocking (omit background) or free a slot with /agy-stop.`,
					},
				],
				details: { ...o.details },
			};
		}
		const runId = run.runId;
		const cleanupStaging = () => {
			// Both staged artifacts must outlive the execute() return in
			// background mode: agy reads them mid-run.
			if (o.contextFile) {
				try {
					fs.unlinkSync(o.contextFile);
				} catch {}
			}
			if (o.reviewerAgent) {
				try {
					fs.rmSync(o.reviewerAgent.dir, { recursive: true, force: true });
				} catch {}
			}
		};
		cleanups.set(runId, cleanupStaging);
		void runAgyProcess({
			binary: o.binary,
			args: o.args,
			workdir: o.workdir,
			timeoutMin: o.timeoutMin,
			startAt: o.startAt,
			details: o.details,
			isContinuation: o.isContinuation,
			snapshot: o.isContinuation ? null : snapshotConversations(CONVERSATIONS_DIR),
			onSpawn: (kill) => {
				kills.set(runId, kill);
			},
		})
			.then((outcome) => {
				kills.delete(runId);
				const finalText = shapeFinalText(o.details, outcome, o.timeoutMin);
				const elapsedS = Math.round((Date.now() - o.startAt) / 1000);
				const handle = o.details.conversationId ? `conversationId=${o.details.conversationId}` : undefined;
				const failed = outcome.timedOut || outcome.exitCode !== 0 || !outcome.answerText;
				// The settle latch makes /agy-stop and shutdown win races
				// against this handler: a false return means their wake went out.
				const settled = registry.settle(runId, {
					status: failed ? "failed" : "done",
					output: finalText,
					handle,
					error: outcome.timedOut
						? `timeout after ${o.timeoutMin}m`
						: outcome.exitCode !== 0
							? `exit status ${outcome.exitCode}`
							: !outcome.answerText
								? "agy exited cleanly but produced no output"
								: undefined,
				});
				if (!settled) return;
				if (outcome.timedOut) {
					const partial = outcome.answerText ? ` Partial output: ${outcome.answerText.slice(0, 400)}` : "";
					sendWake({ toolLabel: "agy", runId, ok: false, elapsedS, error: `timeout after ${o.timeoutMin}m.${partial}`, handle });
				} else if (outcome.exitCode !== 0) {
					const reason = o.details.stderr.trim().slice(0, 400) || `exit status ${outcome.exitCode}`;
					sendWake({ toolLabel: "agy", runId, ok: false, elapsedS, error: reason, handle });
				} else if (!outcome.answerText) {
					sendWake({ toolLabel: "agy", runId, ok: false, elapsedS, error: "agy exited cleanly but produced no output (headless auto-deny?)", handle });
				} else {
					sendWake({ toolLabel: "agy", runId, ok: true, elapsedS, handle }, finalText);
				}
			})
			.catch((err) => {
				kills.delete(runId);
				const msg = err instanceof Error ? err.message : String(err);
				// Settle first: an /agy-stop that won the race owns the wake.
				const settled = registry.settle(runId, { status: "failed", error: msg });
				if (!settled) return;
				sendWake({ toolLabel: "agy", runId, ok: false, error: `failed to run agy: ${msg}` });
			})
			.finally(() => {
				cleanups.delete(runId);
				cleanupStaging();
				if (o.conversationId) busyHandles.delete(o.conversationId);
			});
		return {
			content: [
				{
					type: "text",
					text: `Background run ${runId} started (model=${o.modelLabel}). The result arrives as a message when agy finishes; the resume handle (conversationId) comes with it when agy reports one. Do not poll. Continue with other work or end the turn.`,
				},
			],
			details: { ...o.details },
		};
	};
}

function emptyDetails(
	model: string | null,
	resolvedModel: string | null,
	thinking: ThinkingTier | null = null,
	includeContext: boolean = false,
): AgyDetails {
	return {
		model,
		resolvedModel,
		thinking,
		mode: "accept-edits",
		digest: false,
		includeContext,
		conversationId: null,
		exitCode: 0,
		aborted: false,
		timedOut: false,
		durationMs: 0,
		stderr: "",
	};
}
