/**
 * Antigravity (agy) CLI peer adapter: the agy-specific domain knowledge
 * shared by pi-ask-antigravity, pi-antigravity-bridge's ask-tool, and
 * (later) pi-unblock consults. Extracted verbatim from pi-ask-antigravity's
 * extensions/index.ts (behavior-preserving).
 *
 * Scope: the `agy models` line grammar, tiered alias resolution, plan-mode
 * prompt guards, argv construction for `agy -p`, and the SQLite
 * conversation-id discovery technique. Orchestration (registry, wake, UI,
 * config, reviewer-agent staging) stays in the extension.
 *
 * TRANSPORT NOTE: agy is a RAW-output peer (no line protocol): the answer
 * is the full stdout, trimmed. runProcess runs in raw mode (no onLine) and
 * callers stream progress via onChunk.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compareVersionsDesc } from "../versions.js";

// --- Types -----------------------------------------------------------------

export type ThinkingTier = "low" | "medium" | "high";
export type Family = "flash" | "pro" | "other";

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

export type Mode = "plan" | "accept-edits";

/** Per-family fallback tier when none is specified and no config default.
 *  Flash defaults to medium (per spec); Pro only ships Low/High, so "latest
 *  and greatest" = high. */
export const FAMILY_DEFAULT_TIER: Record<Family, ThinkingTier> = {
	flash: "medium",
	pro: "high",
	other: "medium",
};

export const TIER_RANK: Record<ThinkingTier, number> = { low: 0, medium: 1, high: 2 };

/** pi thinking-level vocabulary -> agy tier, for the thinking/effort tool
 *  params. Unknown values fall to low (agy always thinks something). */
export function levelToTier(level: string): ThinkingTier {
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

// --- Model catalog ----------------------------------------------------------

// Static alias overlay for non-Gemini models agy may or may not surface in
// `agy models` depending on plan. When the live catalog contains an entry
// whose full string equals the overlay target, the live entry wins. When it
// does not (older agy, missing model, plan gate), the overlay entry resolves
// the alias so the user can still type "sonnet" and get a working answer.
//   "sonnet"   -> claude-sonnet-5-5 (tiered low/medium/high like Gemini)
//   "opus"     -> claude-opus-5-5 (tiered low/medium/high like Gemini)
const STATIC_ALIAS_OVERLAY: ReadonlyArray<ModelEntry> = [
	{ full: "claude-sonnet-5-5-low", family: "other", version: null, tier: "low" },
	{ full: "claude-sonnet-5-5-medium", family: "other", version: null, tier: "medium" },
	{ full: "claude-sonnet-5-5-high", family: "other", version: null, tier: "high" },
	{ full: "claude-opus-5-5-low", family: "other", version: null, tier: "low" },
	{ full: "claude-opus-5-5-medium", family: "other", version: null, tier: "medium" },
	{ full: "claude-opus-5-5-high", family: "other", version: null, tier: "high" },
];

// Short alias → overlay full string. Used by resolveModel to recognize
// friendly short names ("sonnet") that the family-parser (flash/pro) does
// not match. The overlay entries are also merged into the live catalog for
// exact-string passthrough, so this map only needs to cover the short names.
const STATIC_SHORT_ALIAS: ReadonlyMap<string, string> = new Map([
	["sonnet", "claude-sonnet-5-5"],
	["opus", "claude-opus-5-5"],
]);

/** Families dropped outright even while `agy models` still lists them: the
 *  fixed-thinking single slug loses to the cheaper effort-tiered options and
 *  its removal upstream is already announced, so we stop offering it now. */
const HIDDEN_FAMILY_RE = /^gpt-oss-/;

/** Drop families we refuse to offer. Exported pure so tests exercise the
 *  same filter the live parse runs; discovery applies it per load. */
export function filterHiddenModels(entries: ModelEntry[]): ModelEntry[] {
	return entries.filter((e) => !HIDDEN_FAMILY_RE.test(e.full));
}

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

/** Build the argv-facing resolution from a picked catalog entry. Gemini and
 *  Claude bases (slugs starting "gemini-"/"claude-") accept a separate
 *  --effort, so split the tier suffix out of the slug: the base alone
 *  (claude-sonnet-5-5) is what --model wants, and the tier goes to --effort
 *  (agy rejects a bare base: "requires --effort"). Only unverified families
 *  keep agy's exact slug whole, so an unknown suffix can never trigger an
 *  unsupported --effort. */
function toResolved(full: string, tier: ThinkingTier | null): ResolvedModel {
	if (tier && /^(gemini|claude)-/.test(full.toLowerCase())) {
		return { model: full.replace(/-(low|medium|high)$/, ""), effort: tier };
	}
	return { model: full };
}

/** Resolve a tiered base id - a short-alias target ("claude-sonnet-5-5") or a
 *  bare base slug the provider itself advertises - to the catalog variant
 *  nearest the requested tier. A bare base alone is invalid upstream
 *  ("requires --effort"), so the pick always rides the split in toResolved;
 *  with no variants in the catalog, the overlay/exact entry or the raw base
 *  passes through unchanged. */
function resolveTieredBase(
	base: string,
	entries: ModelEntry[],
	defaultThinking: ThinkingTier,
	preferredTier: ThinkingTier | undefined,
): ResolvedModel {
	const needle = base.toLowerCase();
	const variants = entries.filter((e) => e.full.toLowerCase().startsWith(`${needle}-`));
	if (variants.length > 0) {
		const tiers = variants.map((e) => e.tier).filter((t): t is ThinkingTier => t !== null);
		const preferred =
			preferredTier ??
			(tiers.includes(defaultThinking) ? defaultThinking : FAMILY_DEFAULT_TIER.other);
		const chosen = nearestTier(tiers, preferred);
		const picked = variants.find((e) => e.tier === chosen) ?? variants[0];
		return toResolved(picked.full, picked.tier);
	}
	const fromCatalog = entries.find((e) => e.full.toLowerCase() === needle);
	return toResolved(fromCatalog?.full ?? base, fromCatalog?.tier ?? null);
}

/**
 * Resolve a friendly alias / partial name to an argv-facing {model, effort?}.
 * Returns null only when the family is unrecognized; the caller then passes
 * the raw input straight to agy.
 */
export function resolveAgyModel(
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

	// 1b. Static short alias ("sonnet" / "opus"). Checked
	//     before the family parser because none of these names contain
	//     "flash" or "pro" and would otherwise return null below. The
	//     resolved full string is then re-validated against the catalog
	//     in step 1's second pass on the next call, so renaming the
	//     overlay entry in code still wins on exact-string match.
	//     The case-insensitive lookup matches mergeCatalog's dedup logic
	//     so the "live entries win" guarantee holds even when agy lists
	//     the model under different casing than the overlay.
	if (STATIC_SHORT_ALIAS.has(lower)) {
		return resolveTieredBase(
			STATIC_SHORT_ALIAS.get(lower) as string,
			entries,
			defaultThinking,
			preferredTier,
		);
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
	if (!family) {
		// A bare base slug the provider itself advertises ("claude-sonnet-5-5",
		// the id behind the antigravity/ entry in pi's picker) is invalid
		// upstream without an effort: resolve it to the nearest tier variant
		// exactly like the short aliases.
		if (
			entries.some((e) => e.full.toLowerCase().startsWith(`${lower}-`)) ||
			entries.some((e) => e.full.toLowerCase() === lower)
		) {
			return resolveTieredBase(lower, entries, defaultThinking, preferredTier);
		}
		return null; // unknown family -> let agy handle it
	}

	// 3. Filter by family.
	let candidates = entries.filter((e) => e.family === family);
	if (candidates.length === 0) return null;

	// 4. Pin version if specified; otherwise pick the HIGHEST version
	//    (numeric compare, not lexical — see compareVersionsDesc in
	//    versions.ts).
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

/** Descending numeric version compare. "3.10" > "3.9" (lexical sort would
 *  wrongly rank "3.9" higher because '9' > '1'). Shared primitive (versions.ts). */

// --- Prompt assembly -------------------------------------------------------

/** Appended to every headless plan-mode prompt. `agy -p` cannot answer
 *  permission prompts: in plan mode a run_command attempt is soft-denied and
 *  the turn ends AT the denial (exit 0, empty stdout, notice only on stderr -
 *  the empty-output branch in execute). Probed 2026-09-28 on agy 1.2.12:
 *  allow rules ARE consulted (a verbatim allow-listed `git log` runs), but
 *  --sandbox does NOT relax the command gate, so the only input every user
 *  is guaranteed is the prompt itself. The guard steers the model to answer
 *  from that material. accept-edits runs keep their tools and never get it. */
export const PLAN_HEADLESS_GUARD = [
	"",
	"--- Headless session constraints ---",
	"- Do not run shell commands. Command execution is denied in this session, and any attempt ends the session immediately with no answer.",
	"- Work only from the material provided in this prompt.",
	"- If information you need is missing, state exactly what is missing in your answer instead of trying to fetch it.",
].join("\n");

/** Guard for plan runs backed by the restricted reviewer agent. Difference
 *  to PLAN_HEADLESS_GUARD: read commands are the intended analysis path
 *  here, so the guard forbids FILE MUTATION - by tool or by shell - and
 *  keeps the answer-from-material discipline. The agent is a damper, not
 *  enforcement (upstream #1181); a headless command attempt can still be
 *  auto-denied, which ends the run, so the guard steers toward view_file
 *  and staged material first. */
export const AGENT_REVIEW_GUARD = [
	"",
	"--- Review constraints ---",
	"- Read-only review. Do not create, modify, or delete any files, including through shell commands (no redirects, tee, rm, mv, git commit).",
	"- Prefer the staged material and view_file for reading. If you run a read-only command (git log, git diff, rg, ls) and it comes back denied, the run ends without an answer: state what you could not check instead of retrying commands.",
	"- Work from the material provided in this prompt; if information you need is missing, state exactly what is missing in your answer.",
].join("\n");

/** Assemble the prompt sent to agy: digest marker first (existing behavior),
 *  then the caller's prompt, then the plan-mode guard last - the position
 *  the model reads with the most recency. No user-config mutation: this is
 *  the only plan-mode lever the tool itself owns. */
export function buildFinalPrompt(
	prompt: string,
	mode: Mode,
	digest: boolean,
	/** True when the restricted reviewer agent is staged: its empty edit
	 *  toolset is a damper (the CLI does not enforce review-only, upstream
	 *  #1181), so the prompt may ALLOW read-only commands. */
	agentDamper = false,
): string {
	let out = digest ? `(Use compact digests, not full file contents.)\n${prompt}` : prompt;
	if (mode === "plan") out += agentDamper ? AGENT_REVIEW_GUARD : PLAN_HEADLESS_GUARD;
	return out;
}

// --- Argv building ----------------------------------------------------------

// agy conversation ids are UUID DB-stems (e.g. "9e6fdc2f-f9f9-4096-95fc-7852528b50cc").
// Reject anything that isn't, so a leading-dash value can't misbind on agy's
// arg parser as the token after --conversation. First char must be
// alphanumeric (rejects leading-dash flag injection); hyphens allowed in the
// body because real UUIDs contain them.
export const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export interface BuildAgyArgsOptions {
	cwd: string;
	/** Resolved --model/--effort pair; an empty model omits both flags
	 *  (unverified input passes through by NOT being set here). */
	resolved: ResolvedModel;
	mode: Mode;
	/** Staged reviewer agent for plan runs; omitted for headless plan. */
	reviewerAgentName?: string | null;
	/** Shared permissions setting; the flag NEVER lands on plan runs. */
	skipPermissions: boolean;
	/** Continuation conversation id; must already pass CONV_ID_RE. */
	conversationId?: string | null;
	timeoutMinutes: number;
	/** Extra --add-dir entries (context exports); appended after cwd. */
	addDirs?: string[];
	/** Pre-split env extras (AGY_EXTRA_ARGS); plan runs strip the skip flag. */
	extraArgs: string[];
	prompt: string;
}

/** Build the `agy` argv for a `-p` run. Pure function so tests can pin the
 *  shape. The prompt travels as the trailing positional after -p. */
export function buildAgyArgs(opts: BuildAgyArgsOptions): string[] {
	const args: string[] = ["--add-dir", opts.cwd];
	// Fail-closed on every plan run: AGY_EXTRA_ARGS lands before the mode
	// flags, so an env-injected skip flag would re-arm exactly what the
	// never-flag-on-plan rule withholds (upstream #1181: an auto-approved
	// plan run is write-capable). The reviewer agent is a damper, not a
	// license for the flag.
	const extra =
		opts.mode === "plan"
			? opts.extraArgs.filter((a) => !a.startsWith("--dangerously-skip-permissions"))
			: opts.extraArgs;
	if (extra.length) args.push(...extra);
	if (opts.resolved.model) args.push("--model", opts.resolved.model);
	if (opts.resolved.effort) args.push("--effort", opts.resolved.effort);
	args.push("--mode", opts.mode);
	if (opts.reviewerAgentName) args.push("--agent", opts.reviewerAgentName);
	// accept-edits auto-approves file edits but NOT shell commands, so a
	// run_command would hang on an unanswerable y/n prompt in non-interactive
	// -p mode. Honor the shared permissions setting (same knob as the bridge).
	// Plan runs NEVER get the flag: it auto-approves every permission
	// request, and the CLI does not gate writes under plan mode (upstream
	// google-antigravity/antigravity-cli#1181, probed 2026-10-07), so an
	// auto-approved plan run is a write-capable run. The reviewer agent's
	// toolset is a damper, not a guarantee; the 2026-09-28 "safe with the
	// restricted toolset" probe predates the #1181 evidence. Without the
	// flag, command attempts fail visibly (headless auto-deny) instead of
	// running approved.
	if (opts.skipPermissions && opts.mode !== "plan") {
		args.push("--dangerously-skip-permissions");
	}
	if (opts.conversationId) args.push("--conversation", opts.conversationId);
	args.push("--print-timeout", `${opts.timeoutMinutes}m`);
	for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);
	args.push("-p", opts.prompt);

	return args;
}

// --- Conversation discovery (the one technique borrowed from antigravity-acp) --
// agy -p does NOT print the conversation id, so for a fresh prompt we snapshot
// the conversations dir before spawn and pick the single new .db after. For a
// continued call we pass --conversation <id> and agy reuses it (no new file).

export const CONVERSATIONS_DIR =
	process.env.AGY_CONVERSATIONS_DIR ||
	path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");

/** Snapshot the set of conversation ids (*.db stems) currently on disk. */
export function snapshotConversations(dir: string): Set<string> {
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
export type OpenDbResolver = (
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

/** The /proc FD-scan resolver shared by all agy peers. Exported so the
 *  bridge's disambiguation tests exercise the exact implementation runs use. */
export const procTreeOpenDbResolver: OpenDbResolver = (rootPid, dir, candidates) => {
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
	/** Called only when new ids appeared but the bind stayed unresolved —
	 *  lets callers bound their retry budget to the genuinely-ambiguous case
	 *  (bridge semantics, absorbed verbatim with discovery.ts). */
	onAmbiguous?: () => void;
}

/** Find the conversation id created since `before`. Returns null when none
 *  appeared, or when several appeared and we cannot tie one to our process.
 *  Pass `opts.pid` (the spawned agy) to enable concurrent-run disambiguation
 *  via the process-tree FD scan. */
export function newConversationId(
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
	opts.onAmbiguous?.();
	return null;
}
