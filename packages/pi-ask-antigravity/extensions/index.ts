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

import { spawn } from "node:child_process";
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

// --- Constants -------------------------------------------------------------

const DEFAULT_TIMEOUT_MIN = 10;
const GRACE_AFTER_TIMEOUT_MS = 5000;
const STATUS_INTERVAL_MS = 1000;
const STATUS_TAIL_CHARS = 160;
const DISCOVERY_TIMEOUT_MS = 8_000;
const DISCOVERY_POLL_ATTEMPTS = 5;
const DISCOVERY_POLL_MS = 100;
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "ask-antigravity.json");

// renderCall / renderResult preview limits (match pi-claude-bridge).
const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

const DEFAULT_MODEL = "flash";
const DEFAULT_THINKING = "medium";
// Default on: without --dangerously-skip-permissions, any run_command hangs in
// non-interactive -p mode (accept-edits auto-approves edits, NOT commands).
const DEFAULT_SKIP_PERMISSIONS = true;

// Per-family fallback tier when none is specified and no config default.
// Flash defaults to medium (per spec); Pro only ships Low/High, so "latest
// and greatest" = high.
const FAMILY_DEFAULT_TIER: Record<Family, ThinkingTier> = {
	flash: "medium",
	pro: "high",
	other: "medium",
};

const TIER_RANK: Record<ThinkingTier, number> = { low: 0, medium: 1, high: 2 };

/** pi thinking-level vocabulary -> agy tier, for the thinking/effort tool
 *  params. Unknown values fall to low (agy always thinks something). */
function levelToTier(level: string): ThinkingTier {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
		case "xhigh":
		case "max":
			return "high";
		default:
			return "low";
	}
}

// Mode = which agy tool-loop policy to apply. Distinct from the alias layer.
//   "plan"         → --mode plan     (no edits; review-only)
//   "accept-edits" → --mode accept-edits (agy applies edits)
//
// Note: agy's --sandbox flag is an orthogonal shell-containment setting
// (not an "edit preview" mode), so it is not exposed here. Users who need
// it can pass it via the AGY_EXTRA_ARGS env var.
type Mode = "plan" | "accept-edits";

// Static alias overlay for non-Gemini models agy may or may not surface in
// `agy models` depending on plan. When the live catalog contains an entry
// whose full string equals the overlay target, the live entry wins. When it
// does not (older agy, missing model, plan gate), the overlay entry resolves
// the alias so the user can still type "sonnet" and get a working answer.
//   "sonnet"   -> claude-sonnet-4-6
//   "opus"     -> claude-opus-4-6-thinking
//   "gpt-oss"  -> gpt-oss-120b-medium
const STATIC_ALIAS_OVERLAY: ReadonlyArray<ModelEntry> = [
	{ full: "claude-sonnet-4-6", family: "other", version: null, tier: null },
	{ full: "claude-opus-4-6-thinking", family: "other", version: null, tier: null },
	{ full: "gpt-oss-120b-medium", family: "other", version: null, tier: null },
];

// Short alias → overlay full string. Used by resolveModel to recognize
// friendly short names ("sonnet") that the family-parser (flash/pro) does
// not match. The overlay entries are also merged into the live catalog for
// exact-string passthrough, so this map only needs to cover the short names.
const STATIC_SHORT_ALIAS: ReadonlyMap<string, string> = new Map([
	["sonnet", "claude-sonnet-4-6"],
	["opus", "claude-opus-4-6-thinking"],
	["gpt-oss", "gpt-oss-120b-medium"],
]);

/** Merge the live catalog with the static alias overlay. Live entries win on
 *  case-insensitive full-string equality so an updated `agy models` listing
 *  always takes precedence over the hardcoded fallback. */
export function mergeCatalog(live: ModelEntry[]): ModelEntry[] {
	const seen = new Set(live.map((e) => e.full.toLowerCase()));
	const merged = [...live];
	for (const entry of STATIC_ALIAS_OVERLAY) {
		if (!seen.has(entry.full.toLowerCase())) merged.push(entry);
	}
	return merged;
}

// agy conversation ids are UUID DB-stems (e.g. "9e6fdc2f-f9f9-4096-95fc-7852528b50cc").
// Reject anything that isn't, so a leading-dash value can't misbind on agy's
// arg parser as the token after --conversation. First char must be
// alphanumeric (rejects leading-dash flag injection); hyphens allowed in the
// body because real UUIDs contain them.
const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

const AGY_DESCRIPTION = `Delegate a self-contained sub-task to Google Antigravity. agy is the CLI for Gemini, so this tool is reached under three equivalent names the user may use interchangeably: **gemini**, **antigravity**, and **agy**. When the user says "ask gemini", "ask antigravity", "ask agy", or otherwise refers to any of these, call THIS tool. agy runs its OWN tool loop: it can read, write, edit, and execute inside the workspace, then returns its final answer. Use for a second opinion from a different model family, Gemini-specific reasoning, or isolated sub-tasks you do not need to drive step-by-step. Provide a complete, self-contained task description; agy will not see this conversation.

TWO MODES (you choose):
- **One-shot (isolated)**: omit conversationId. agy starts fresh with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the conversationId returned in the PREVIOUS call's details (details.conversationId). agy resumes that conversation with full context intact — use for follow-ups, multi-turn refinement, or when the user says "ask agy to follow up / continue / now do X based on what you just did". Thread the id from each result into the next call.

EXECUTION MODES (param: mode):
- **plan**: agy reviews and plans without writing. Use for cross-review and read-only tasks.
- **accept-edits** (default): agy applies edits directly inside the workspace.
- For agy's orthogonal \`--sandbox\` shell-containment flag, set the \`AGY_EXTRA_ARGS=--sandbox\` env var.

COMPACT OUTPUT (param: digest): when true, the prompt is prefixed to request compact digests instead of full file contents. Defaults on for plan, off for accept-edits. Use true whenever you do not need full file payloads (review, exploration, planning).

THINKING LEVEL (params: thinking, effort - SYNONYMS for one knob):
- pi calls it thinking, agy calls it effort. Same thing. Pass ONE of the two.
- Values (pi vocabulary): minimal|low|medium|high|xhigh|max. Clamped to agy's low|medium|high; unknown values fall back to low. "peer review on high thinking" -> thinking: "high".
- An explicit level beats a tier embedded in model ("flash high") and the configured default. Omit both for the configured default.`;

// --- Types -----------------------------------------------------------------

type ThinkingTier = "low" | "medium" | "high";
type Family = "flash" | "pro" | "other";

export interface ModelEntry {
	full: string; // exact agy slug, e.g. "gemini-3.6-flash-medium"
	family: Family;
	version: string | null; // "3.6"
	tier: ThinkingTier | null;
}

/** Argv-facing model resolution: the exact --model slug plus an optional
 *  --effort tier. Gemini bases split the tier out (the base slug alone is
 *  invalid without --effort); fixed-thinking families keep agy's exact slug
 *  and carry no effort. */
export interface ResolvedModel {
	model: string;
	effort?: ThinkingTier;
}

interface Config {
	defaultModel: string;
	defaultThinking: ThinkingTier;
	/** Pass --dangerously-skip-permissions so commands don't hang on an
	 *  unanswerable y/n prompt in non-interactive -p mode. Default true. */
	skipPermissions: boolean;
}

// --- Version helpers -------------------------------------------------------

/** Descending numeric version compare. "3.10" > "3.9" (lexical sort would
 *  wrongly rank "3.9" higher because '9' > '1'). */
function compareVersionsDesc(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return db - da; // descending
	}
	return 0;
}

// --- Config ----------------------------------------------------------------

function projectConfigPath(): string {
	return path.join(process.cwd(), ".pi", "ask-antigravity.json");
}

function tryReadJson(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function loadConfig(): Config {
	const global = tryReadJson(GLOBAL_CONFIG_PATH);
	const project = tryReadJson(projectConfigPath());
	const merged = { ...global, ...project };

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

interface SaveResult {
	path: string;
	/** Keys whose effect is shadowed by a project config (info only). */
	routedToProject: boolean;
}

/** Persist a config patch. If the project config already defines any patched
 *  key, write to the PROJECT file so the change actually takes effect
 *  (project shadows global on load); otherwise write to global.
 *  Atomic: temp file + rename, with temp cleanup on failure. */
function saveConfig(patch: Partial<Config>): SaveResult {
	const projectRaw = tryReadJson(projectConfigPath());
	const projectShadows = Object.keys(patch).some((k) => k in projectRaw);
	const targetPath = projectShadows ? projectConfigPath() : GLOBAL_CONFIG_PATH;

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

// --- Model parsing + alias resolution --------------------------------------

/** Parse one `agy models` line into a structured entry. */
export function parseModelLine(line: string): ModelEntry | null {
	// agy prints TWO columns: "<slug>  <display label>". --model takes only the
	// slug (col 1), so split it off; the label is display-only. A bare-slug line
	// (no whitespace) splits to itself.
	const full = line.trim().split(/\s+/)[0] ?? "";
	if (!full) return null;

	const lower = full.toLowerCase();
	const family: Family = lower.includes("flash")
		? "flash"
		: lower.includes("pro")
			? "pro"
			: "other";

	const versionMatch = lower.match(/(\d+\.\d+)/);
	const version = versionMatch ? versionMatch[1] : null;

	const tierMatch = lower.match(/-(low|medium|high)$/);
	const tier = tierMatch ? (tierMatch[1] as ThinkingTier) : null;

	return { full, family, version, tier };
}

/** Pick the available tier closest in rank to the preferred one. Distance
 *  ties (e.g. Low/High around Medium) break toward the higher tier so
 *  "latest and greatest" wins when a family lacks the requested tier. */
function nearestTier(available: ThinkingTier[], preferred: ThinkingTier): ThinkingTier {
	if (available.includes(preferred)) return preferred;
	const sorted = [...available].sort((a, b) => {
		const da = Math.abs(TIER_RANK[a] - TIER_RANK[preferred]);
		const db = Math.abs(TIER_RANK[b] - TIER_RANK[preferred]);
		return da !== db ? da - db : TIER_RANK[b] - TIER_RANK[a];
	});
	return sorted[0] ?? preferred;
}

/** Build the argv-facing resolution from a picked catalog entry. Gemini bases
 *  (slugs starting "gemini-") accept a separate --effort, so split the tier
 *  suffix out of the slug: the base alone (gemini-3.6-flash) is what --model
 *  wants, and the tier goes to --effort. Fixed-thinking families keep agy's
 *  exact slug even when it carries a -medium suffix (gpt-oss-120b-medium):
 *  agy rejects --effort for them, so the suffix stays part of the slug. */
function toResolved(full: string, tier: ThinkingTier | null): ResolvedModel {
	if (tier && full.toLowerCase().startsWith("gemini-")) {
		return { model: full.replace(/-(low|medium|high)$/, ""), effort: tier };
	}
	return { model: full };
}

/**
 * Resolve a friendly alias / partial name to an argv-facing {model, effort?}.
 * Returns null only when the family is unrecognized; the caller then passes
 * the raw input straight to agy.
 */
export function resolveModel(
	input: string,
	entries: ModelEntry[],
	defaultThinking: ThinkingTier,
	/** Explicit thinking param (thinking/effort). Beats a tier embedded in
	 *  the alias ("flash high") and the configured default; clamped to the
	 *  family's real tiers, ignored for fixed-thinking families. */
	preferredTier?: ThinkingTier,
): ResolvedModel | null {
	const lower = input.toLowerCase().trim();

	// 1. Exact full-string match (case-insensitive).
	const exact = entries.find((e) => e.full.toLowerCase() === lower);
	if (exact) return toResolved(exact.full, exact.tier);

	// 1b. Static short alias ("sonnet" / "opus" / "gpt-oss"). Checked
	//     before the family parser because none of these names contain
	//     "flash" or "pro" and would otherwise return null below. The
	//     resolved full string is then re-validated against the catalog
	//     in step 1's second pass on the next call, so renaming the
	//     overlay entry in code still wins on exact-string match.
	//     The case-insensitive lookup matches mergeCatalog's dedup logic
	//     so the "live entries win" guarantee holds even when agy lists
	//     the model under different casing than the overlay.
	if (STATIC_SHORT_ALIAS.has(lower)) {
		const target = STATIC_SHORT_ALIAS.get(lower) as string;
		const fromCatalog = entries.find((e) => e.full.toLowerCase() === target.toLowerCase());
		return toResolved(fromCatalog?.full ?? target, fromCatalog?.tier ?? null);
	}

	// 2. Parse the alias.
	let family: Family | null = lower.includes("flash")
		? "flash"
		: lower.includes("pro")
			? "pro"
			: null;
	const versionMatch = lower.match(/(\d+\.\d+)/);
	const version = versionMatch ? versionMatch[1] : null;
	const tierMatch = lower.match(/\b(low|medium|high)\b/);
	const tier = tierMatch ? (tierMatch[1] as ThinkingTier) : null;

	// "gemini" alone, "default", or empty -> default family (flash).
	if (!family && (/gemini/.test(lower) || lower === "" || lower === "default")) {
		family = "flash";
	}
	if (!family) return null; // unknown family -> let agy handle it

	// 3. Filter by family.
	let candidates = entries.filter((e) => e.family === family);
	if (candidates.length === 0) return null;

	// 4. Pin version if specified; otherwise pick the HIGHEST version
	//    (numeric compare, not lexical — see compareVersionsDesc).
	if (version) {
		const versioned = candidates.filter((e) => e.version === version);
		if (versioned.length > 0) candidates = versioned;
	} else {
		// Prefer Google's official `gemini-*-latest` aliases (entries with no
		// parseable version in their name, e.g. "Gemini Flash Latest") when
		// the user did NOT pin a specific version. The alias is the
		// versionless pointer Google intends for "the current release" and
		// hot-swaps on every release, while versioned entries like
		// "Gemini 3.6 Flash (Medium)" stay available via explicit pinning
		// (e.g. "3.6 flash medium"). Falls back to the highest versioned
		// entry if no alias is present in the catalog.
		const aliases = candidates.filter((e) => e.version === null);
		if (aliases.length > 0) {
			candidates = aliases;
		} else {
			const versions = candidates
				.map((e) => e.version)
				.filter((v): v is string => v !== null)
				.sort(compareVersionsDesc);
			if (versions.length > 0) {
				const top = versions[0];
				const latest = candidates.filter((e) => e.version === top);
				if (latest.length > 0) candidates = latest;
			}
		}
	}

	// 5. Pick tier: explicit > config default (if the family offers it) >
	//    family default. Pro has no Medium, so "pro" + default medium falls
	//    back to the Pro family default (High), not nearest-Medium.
	const familyTiers = new Set(
		candidates.map((e) => e.tier).filter((t): t is ThinkingTier => t !== null),
	);
	if (familyTiers.size === 0) return toResolved(candidates[0].full, null); // no tiers on any entry

	const preferred =
		preferredTier ??
		tier ??
		(familyTiers.has(defaultThinking) ? defaultThinking : FAMILY_DEFAULT_TIER[family]);
	const chosenTier = nearestTier([...familyTiers], preferred);
	const picked = candidates.find((e) => e.tier === chosenTier) ?? candidates[0];
	return toResolved(picked.full, picked.tier);
}

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
		return text
			.split("\n")
			.map(parseModelLine)
			.filter((e): e is ModelEntry => e !== null);
	} catch {
		return [];
	}
}

function extraArgs(): string[] {
	const raw = process.env.AGY_EXTRA_ARGS;
	return raw ? raw.split(/\s+/).filter((s) => s.length > 0) : [];
}

// --- Conversation discovery (the one technique borrowed from antigravity-acp) --
// agy -p does NOT print the conversation id, so for a fresh prompt we snapshot
// the conversations dir before spawn and pick the single new .db after. For a
// continued call we pass --conversation <id> and agy reuses it (no new file).

const CONVERSATIONS_DIR =
	process.env.AGY_CONVERSATIONS_DIR ||
	path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");

/** Snapshot the set of conversation ids (*.db stems) currently on disk. */
function snapshotConversations(dir: string): Set<string> {
	const out = new Set<string>();
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return out;
	}
	for (const f of entries) {
		if (f.endsWith(".db")) out.add(f.slice(0, -3));
	}
	return out;
}

/** Resolve which of the `candidates` DB ids is held open by the process tree
 *  rooted at `rootPid`. Used to disambiguate concurrent agy runs. Returns the
 *  single matching id, or null when none/several are open or /proc is
 *  unavailable. Ported from pi-antigravity-bridge src/discovery.ts; keep in
 *  sync. */
type OpenDbResolver = (
	rootPid: number,
	dir: string,
	candidates: Set<string>,
) => string | null;

function readProcStat(pid: number): { pid: number; ppid: number } | null {
	let raw: string;
	try {
		raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	const closeParen = raw.lastIndexOf(")");
	if (closeParen < 0) return null;
	const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
	const ppid = Number(fields[1]);
	if (!Number.isFinite(ppid)) return null;
	return { pid, ppid };
}

function collectDescendants(rootPid: number): Set<number> {
	const out = new Set<number>([rootPid]);
	let entries: string[];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return out;
	}
	const ppidOf = new Map<number, number>();
	for (const e of entries) {
		if (!/^\d+$/.test(e)) continue;
		const s = readProcStat(Number(e));
		if (s) ppidOf.set(s.pid, s.ppid);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, ppid] of ppidOf) {
			if (out.has(pid)) continue;
			if (out.has(ppid)) {
				out.add(pid);
				changed = true;
			}
		}
	}
	return out;
}

function safeRealpath(p: string): string | null {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

const procTreeOpenDbResolver: OpenDbResolver = (rootPid, dir, candidates) => {
	if (candidates.size <= 1) return null;
	if (process.platform !== "linux") return null;
	const dirResolved = safeRealpath(dir);
	const tree = collectDescendants(rootPid);
	const found = new Set<string>();
	for (const pid of tree) {
		let fds: string[];
		try {
			fds = fs.readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue;
		}
		for (const fd of fds) {
			let target: string;
			try {
				target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
			} catch {
				continue;
		}
			const base = path.basename(target);
			if (!base.endsWith(".db")) continue;
			if (dirResolved && safeRealpath(path.dirname(target)) !== dirResolved) continue;
			const id = base.slice(0, -3);
			if (candidates.has(id)) found.add(id);
		}
	}
	if (found.size === 1) return [...found][0] ?? null;
	return null;
};

interface BindOptions {
	pid?: number;
	resolveOpenDb?: OpenDbResolver;
}

/** Find the conversation id created since `before`. Returns null when none
 *  appeared, or when several appeared and we cannot tie one to our process.
 *  Pass `opts.pid` (the spawned agy) to enable concurrent-run disambiguation
 *  via the process-tree FD scan. */
function newConversationId(
	dir: string,
	before: Set<string>,
	opts: BindOptions = {},
): string | null {
	const created = [...snapshotConversations(dir)].filter((id) => !before.has(id));
	if (created.length === 0) return null;
	if (created.length === 1) return created[0] ?? null;
	// Ambiguous: try to authoritatively identify ours via the spawned
	// process's open files. Fail safe to null when we can't pick exactly one.
	if (opts.pid !== undefined) {
		const resolve = opts.resolveOpenDb ?? procTreeOpenDbResolver;
		const hit = resolve(opts.pid, dir, new Set(created));
		if (hit && created.includes(hit)) return hit;
	}
	return null;
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
	durationMs: number;
	stderr: string;
}

export default async function (pi: ExtensionAPI) {
	// If pi-antigravity-bridge is installed, it owns the AskAntigravity tool
	// (and the provider). Stay silent and register nothing to avoid a
	// duplicate-tool clash. Without the bridge, this extension behaves as
	// before (standalone tool).
	if (isBridgeInstalled()) return;

	const binary = resolveAgy();
	// Discovered once at load; frozen for the session. Run /reload after an
	// `agy update` to refresh. Failure is non-fatal: resolveModel falls back
	// to passthrough so exact slugs typed by the user still work. The static
	// alias overlay (sonnet / opus / gpt-oss) is merged on top so those
	// aliases resolve even when agy doesn't surface them in the live catalog.
	const discovered = mergeCatalog(await discoverModels(binary).catch(() => []));

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
						`  resolved:        ${resolveModel(config.defaultModel, discovered, config.defaultThinking)?.model ?? "(agy default)"}`,
						``,
						`Edit: ~/.pi/agent/ask-antigravity.json`,
					].join("\n"),
					"info",
				);
				return;
			}

			// Resolve the display string for the current default model.
			const currentResolved =
				resolveModel(config.defaultModel, discovered, config.defaultThinking)?.model ?? config.defaultModel;

			const items: SettingItem[] = [
				{
					id: "defaultModel",
					label: "Default model",
					description:
						"Friendly alias resolved to the latest matching agy model. 'flash' = latest Flash, 'pro' = latest Pro, 'gemini' = latest Flash.",
					currentValue: `${config.defaultModel} → ${currentResolved}`,
					values: MODEL_OPTIONS.map((m) => {
						const r = resolveModel(m, discovered, config.defaultThinking)?.model ?? m;
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
							"agy execution mode. 'plan' = review-only, no edits (--mode plan). 'accept-edits' = agy applies edits directly (--mode accept-edits, default). For agy's orthogonal --sandbox shell-containment flag, set the AGY_EXTRA_ARGS env var.",
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
		}),
		renderCall(args, theme, _context) {
			// Show RESOLVED model/thinking/mode (config defaults applied) so the
			// row identifies what will actually run, not just explicit args.
			// agy folds the thinking tier into the model alias or --effort; we
			// surface the resolved tier separately for identification.
			const cfg = loadConfig();
			const requestedModel = (args.model as string | undefined)?.trim() || cfg.defaultModel;
			const thinkingArg = (args.thinking as string | undefined) ?? (args.effort as string | undefined);
			const resolved =
				resolveModel(
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
			const errored = d?.exitCode !== 0 || !!d?.aborted || !!d?.timedOut;

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
			const resolved =
				resolveModel(
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
			// digest default: on for plan (review-only contexts where full file
			// contents are noise), off for accept-edits (agy applies edits and
			// may need richer context for diffs).
			const useDigest: boolean =
				typeof params.digest === "boolean"
					? params.digest
					: mode === "plan";
			const finalPrompt: string = useDigest
				? `(Use compact digests, not full file contents.)\n${params.prompt}`
				: params.prompt;

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

			const args: string[] = ["--add-dir", cwd];
			const extra = extraArgs();
			if (extra.length) args.push(...extra);
			if (resolved.model) args.push("--model", resolved.model);
			if (resolved.effort) args.push("--effort", resolved.effort);
			args.push("--mode", mode);
			// accept-edits auto-approves file edits but NOT shell commands, so a
			// run_command would hang on an unanswerable y/n prompt in non-interactive
			// -p mode. Honor the shared permissions setting (same knob as the bridge).
			if (config.skipPermissions) args.push("--dangerously-skip-permissions");
			if (isContinuation) args.push("--conversation", rawConvId as string);
			args.push("--print-timeout", `${timeoutMin}m`);
			if (contextFile) args.push("--add-dir", askContextDir());
			args.push("-p", effectivePrompt);

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

			let out = "";

			// Throttled status updates (claude-bridge pattern): emit a short
			// status line on an interval instead of the full buffer on every
			// stdout chunk, avoiding O(n²) re-renders on long runs.
			const statusInterval = onUpdate
				? setInterval(() => {
						const elapsed = Math.floor((Date.now() - start) / 1000);
						const tail = out.slice(-STATUS_TAIL_CHARS);
						const text = tail
							? `(running ${elapsed}s)\n…${tail}`
							: `(running ${elapsed}s)`;
						onUpdate({
							content: [{ type: "text", text }],
							details: { ...details, durationMs: Date.now() - start },
						});
					}, STATUS_INTERVAL_MS)
				: null;

			try {
				// Bind the conversation id DURING the run (agy is alive then) so the
				// pid-based /proc FD resolver can disambiguate when a concurrent agy
				// also drops a new .db. Awaited after the run; the post-exit loop
				// below is the fallback for runs that exit before the poll binds.
				let bindDuringRun: Promise<void> = Promise.resolve();
				const outcome = await new Promise<{
					exitCode: number;
					aborted: boolean;
					timedOut: boolean;
				}>((resolveP, rejectP) => {
					// detached: true so we can signal the whole process group.
					// agy spawns its own exec subprocesses in -p mode; a direct
					// kill would orphan those grandchildren.
					const proc = spawn(binary, args, {
						cwd,
						stdio: ["ignore", "pipe", "pipe"],
						shell: false,
						detached: true,
					});

					// Decode at the stream level so multibyte UTF-8 split across
					// pipe chunks doesn't corrupt (Gemini output is non-ASCII).
					proc.stdout?.setEncoding("utf8");
					proc.stderr?.setEncoding("utf8");

					proc.stdout?.on("data", (d: string) => {
						out += d;
					});
					proc.stderr?.on("data", (d: string) => {
						details.stderr += d;
					});

					// Concurrent bind: poll for the new id while agy is alive. The FD
					// resolver needs a live process tree, so this stops (and the
					// post-exit fallback below takes over) once agy has exited.
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

					let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
					let watchdog: ReturnType<typeof setTimeout> | undefined;
					let settled = false;
					let timedOut = false;

					// Kill the whole process group; SIGTERM first, then SIGKILL
					// after a grace period if it hasn't exited.
					const killTree = () => {
						try {
							if (proc.pid) process.kill(-proc.pid, "SIGTERM");
						} catch {}
						// Only arm the SIGKILL timer once.
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

					// Enforce the timeout cap ourselves (not just via
					// --print-timeout, which agy could ignore or not support).
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
						// Distinguish an aborted run from a normal close: if the
						// abort signal fired, treat as cancelled regardless of
						// exit code (killTree produces a non-zero code, but be
						// explicit and order-independent). Likewise surface a
						// timeout distinctly from a genuine non-zero exit.
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

				// Let the during-run bind poll finish (it bails immediately once agy
				// has exited, so this rarely blocks).
				await bindDuringRun;

				details.exitCode = outcome.exitCode;
				details.aborted = outcome.aborted;
				details.timedOut = outcome.timedOut;
				details.durationMs = Date.now() - start;

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

				const text = out.trim();

				// Aborted: return a distinct result so the caller knows it was
				// cancelled, not a silent success.
				if (outcome.aborted) {
					return {
						content: [
							{
								type: "text",
								text: text
									? `agy was aborted. Partial output:\n\n${text}`
									: "agy was aborted before producing output.",
							},
						],
						details,
					};
				}

				// Timeout: distinct from a genuine non-zero exit (the watchdog
				// killed the tree because the configured cap elapsed).
				if (outcome.timedOut) {
					const note = `agy exceeded the ${timeoutMin}m timeout and was killed`;
					return {
						content: [
							{ type: "text", text: text ? `${text}\n\n[${note}]` : note },
						],
						details,
					};
				}

				// Non-zero exit: surface the failure even when partial text
				// exists, instead of returning silent success.
				if (outcome.exitCode !== 0) {
					const note = details.stderr.trim()
						? `agy exited with status ${outcome.exitCode}: ${details.stderr.trim()}`
						: `agy exited with status ${outcome.exitCode}`;
					return {
						content: [
							{ type: "text", text: text ? `${text}\n\n[${note}]` : note },
						],
						details,
					};
				}

				// Success. Clear the last partial status line (claude-bridge
				// idiom) so the running-tail preview doesn't linger under the final
				// answer, then append a conversation footer so the orchestrating model
				// can see (and thread) the id without inspecting details.
				onUpdate?.({
					content: [{ type: "text", text: "" }],
					details: { ...details },
				});
				const footer = details.conversationId
					? `\n\n[agy conversationId: ${details.conversationId} — pass as conversationId to continue this conversation]`
					: "";

				return {
					content: [{ type: "text", text: text + footer }],
					details,
				};
			} catch (err) {
				if (statusInterval) clearInterval(statusInterval);
				details.durationMs = Date.now() - start;
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `failed to run agy: ${msg}` }],
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
