/**
 * Codex CLI peer adapter: the codex-specific domain knowledge shared by
 * pi-ask-codex and (later) pi-unblock consults. Extracted verbatim from
 * pi-ask-codex's extensions/index.ts (behavior-preserving).
 *
 * Scope: slug taxonomy + alias resolution against `codex debug models
 * --bundled`, argv construction for `codex exec` (fresh + resume), the
 * exec --json event grammar, status-line vocabulary, and stderr noise
 * filtering. Orchestration (registry, wake, UI, config) stays in the
 * extension.
 *
 * TRANSPORT NOTE: unlike the claude adapter (stdin), codex takes the
 * prompt as a trailing positional after `--` — its documented interface.
 * stdin is ignored (`stdio: "ignore"`) so codex never waits on a tty.
 */

/** Descending numeric version compare. "5.10" > "5.9" (lexical sort would
 *  wrongly rank "5.9" higher because '9' > '1'). */
const compareVersionsDesc = (a: string, b: string): number => {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return db - da; // descending
	}
	return 0;
};

// codex session/thread ids are UUIDs (e.g. "0199a213-81c0-7800-8aa1-bbab2a035a53").
// Anchored to UUID shape so a leading-dash value (e.g.
// "--dangerously-bypass-approvals-and-sandbox") can NEVER pass and misbind
// on codex's arg parser as the token after the resume session-id positional
// — which would silently disable the sandbox. The dash-tolerant variant
// (`[A-Za-z0-9-]`) was a security regression; this is the fix.
export const CODEX_SESSION_ID_RE =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Current codex reasoning-effort ladder (GPT-6 era). "minimal" is retired:
 *  no bundled model lists it anymore. Support is validated per model at call
 *  time against the catalog (gpt-6-luna stops at max, for example). */
export const REASONING_VALUES = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_VALUES)[number];
export const SANDBOX_VALUES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_VALUES)[number];

// Minimal shapes for the JSONL events we actually consume. Unknown fields
// are ignored. See: https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/
export interface CodexEvent {
	type: string;
	thread_id?: string;
	message?: string;
	error?: { message?: string };
	usage?: { input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
	item?: {
		id: string;
		type: string;
		text?: string;
		command?: string;
		status?: string;
		exit_code?: number | null;
		changes?: Array<{ path: string; kind: string }>;
		query?: string;
	};
}

const STATUS_LINES_MAX = 100;

/** Mutable accumulator the event consumer writes into. The extension maps
 *  these onto its own details after each event so partial progress stays
 *  observably identical. */
export interface CodexEventState {
	/** Thread id from thread.started; overwritten on every event (codex
	 *  echoes the resumed id on continuation runs). */
	sessionId: string | null;
	/** Final agent_message text; empty when codex emitted none. */
	finalMessage: string;
	usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null;
	statusLines: string[];
}

export function emptyCodexEventState(): CodexEventState {
	return {
		sessionId: null,
		finalMessage: "",
		usage: null,
		statusLines: [],
	};
}

// --- Model catalog ----------------------------------------------------------

// Codex slug taxonomy (verified against `codex debug models --bundled`,
// codex-cli 0.159.3, GPT-6 era):
//   gpt-X.Y           -> "main" family (plain, legacy naming)
//   gpt-X.Y-sol       -> "main" family (sol = everyday workhorse)
//   gpt-X.Y-terra     -> "main" family (terra = balanced, GPT-5.6 era)
//   gpt-X.Y-astra     -> "frontier" family (astra = most demanding work)
//   gpt-X.Y-luna      -> "fast" family (luna = fast / affordable)
//   gpt-X.Y-mini/nano -> "fast" family (pre-GPT-6 fast tiers)
//   gpt-X.Y-pro       -> "pro" family (deep reasoning)
//   gpt-X.Y-codex     -> "codex" family (legacy coding-tuned naming)
// Anything else (e.g. "gpt-daybreak-blue-latest", "codex-auto-review") is
// excluded from resolution.
type Family = "main" | "frontier" | "fast" | "pro" | "codex" | "other";

export interface CodexModelEntry {
	full: string; // exact slug, e.g. "gpt-6.1-sol"
	family: Family;
	version: string | null; // "6.1" or null if unparseable
	efforts: string[]; // supported reasoning efforts; empty when unknown
	upgrade: string | null; // catalog migration target for deprecated models
	hidden: boolean; // visibility "hide" — exact ids only, never alias-selected
}

/** Map one `codex debug models --bundled` slug to a (family, version) pair.
 *  Unknown shapes (e.g. "codex-auto-review") land in "other" and are
 *  excluded from alias resolution but still valid as exact --model args.
 *
 *  NOTE: the regex captures the suffix as a single token. Compound variants
 *  like `gpt-5.6-mini-pro` are not handled — they fall to "other" and remain
 *  exact-only. If the vendor introduces compound naming, extend the literal
 *  suffix checks below rather than the regex. */
export function classifySlug(slug: string): { family: Family; version: string | null } {
	const m = slug.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i);
	if (!m) return { family: "other", version: null };
	const version = m[1];
	const suffix = m[2];
	if (!suffix) return { family: "main", version };
	const lower = suffix.toLowerCase();
	// GPT-6 era tiers are suffix variants, not standalone families:
	// sol (workhorse) and terra (balanced, 5.6-era) are "main"; astra
	// (frontier) and luna (fast) get their own families so the mini/nano
	// aliases keep pointing at the affordable tier after the -mini naming
	// retired. Legacy -mini/-nano slugs land in "fast" too.
	if (lower === "sol" || lower === "terra") return { family: "main", version };
	if (lower === "astra") return { family: "frontier", version };
	if (lower === "luna" || lower === "mini" || lower === "nano") return { family: "fast", version };
	if (lower === "pro") return { family: "pro", version };
	if (lower === "codex" || lower.startsWith("codex-")) return { family: "codex", version };
	return { family: "other", version };
}

/** Tiebreak priority within the main family at the same version.
 *  sol (workhorse) > plain gpt-X.Y (legacy naming) > terra (balanced) >
 *  anything else. astra and luna have their own families, so they never
 *  compete here. Catalog JSON order from `codex debug models --bundled` is
 *  not part of the contract, so an explicit priority is required for
 *  deterministic flagship selection. */
const MAIN_VARIANT_PRIORITY: Record<string, number> = {
	sol: 0,
	"": 1, // plain gpt-X.Y (no suffix)
	terra: 2,
};
function mainVariantRank(slug: string): number {
	const m = slug.match(/^gpt-\d+(?:\.\d+)?(?:-(.+))?$/i);
	if (!m) return 99;
	const suffix = (m[1] ?? "").toLowerCase();
	return MAIN_VARIANT_PRIORITY[suffix] ?? 99;
}

/** Follow the catalog's official migration chain (deprecated model -> upgrade
 *  target), bounded to 3 hops with a visited set so cycles terminate
 *  deterministically. Deprecated models stay listed in
 *  `codex debug models --bundled` but fail server-side; the upgrade pointer
 *  is the vendor's own replacement, so requests pointing at them migrate
 *  instead of erroring. A pointer to a model absent from the catalog is
 *  still forwarded as a string — dispatching the retired slug would
 *  guarantee a server rejection, while the target may exist server-side. */
function followUpgrades(
	entry: CodexModelEntry,
	entries: CodexModelEntry[],
): { slug: string; entry: CodexModelEntry } {
	let current = entry;
	let slug = entry.full;
	const visited = new Set<string>([entry.full]);
	for (let hops = 0; hops < 3; hops++) {
		if (!current.upgrade) break;
		const target = entries.find((e) => e.full === current.upgrade);
		if (!target) {
			slug = current.upgrade;
			break;
		}
		if (visited.has(target.full)) break;
		visited.add(target.full);
		current = target;
		slug = target.full;
	}
	return { slug, entry: current };
}

/** Resolve a friendly alias / partial name to an exact --model value. Aliases
 *  pick the highest version of the named family; pinned versions (e.g.
 *  "6 mini") select a specific version. Exact slugs verify against the
 *  catalog. Resolutions that land on a deprecated model follow its upgrade
 *  pointer. Returns null flagValue to omit --model entirely (Codex's own
 *  default), and null entry whenever the input passes through unverified. */
export function resolveCodexModel(
	input: string,
	entries: CodexModelEntry[],
): { flagValue: string | null; entry: CodexModelEntry | null } {
	const lower = input.toLowerCase().trim();
	if (lower === "default" || lower === "") return { flagValue: null, entry: null };

	// Apply the migration chain and build the result in one place so every
	// branch shares the same upgrade + reporting behavior.
	const emit = (e: CodexModelEntry) => {
		const r = followUpgrades(e, entries);
		return { flagValue: r.slug, entry: r.entry };
	};

	// 1. Exact slug match against the live catalog (upgrades applied).
	const exact = entries.find((e) => e.full.toLowerCase() === lower);
	if (exact) return emit(exact);

	// 2. Parse the alias into family + optional version. Match the family
	//    keyword as a standalone token (\b) so pinned forms like "6 mini"
	//    / "6.1 full" resolve, but compound slugs that happen to contain
	//    "gpt" or "pro" don't false-match. The exact-slug match above runs
	//    first, so a full slug like "gpt-5.4-mini" never reaches this
	//    branch as a family parse. Tier aliases: mini/nano/luna are the
	//    fast family, astra the frontier family, sol the main family —
	//    GPT-6 retired the -mini suffix, so the affordable tier is now a
	//    variant name. Specific families are checked before the generic
	//    "full" / "gpt" so a "gpt-...-mini" intent routes to fast.
	let family: Family | null = null;
	if (/\b(mini|nano|luna)\b/.test(lower)) family = "fast";
	else if (/\bastra\b/.test(lower)) family = "frontier";
	else if (/\bcodex\b/.test(lower)) family = "codex";
	else if (/\bpro\b/.test(lower)) family = "pro";
	else if (/\b(full|gpt|sol)\b/.test(lower)) family = "main";

	// Unknown alias (e.g. a bare version like "6") or unparseable input —
	// passthrough to codex and let it decide. Exact user-typed slugs and
	// API-key-only model ids keep working this way even when discovery fails.
	if (family === null) return { flagValue: input, entry: null };

	const versionMatch = lower.match(/(\d+(?:\.\d+)?)/);
	const pinnedVersion = versionMatch ? versionMatch[1] : null;

	// 3. Filter by family. Hidden entries (experiments, internal reviewers)
	//    are in the catalog for exact matching only — they never win aliases.
	let candidates = entries.filter((e) => e.family === family && !e.hidden);
	if (candidates.length === 0) {
		// Family not in the catalog (e.g. no pro models this release) —
		// passthrough rather than fabricating.
		return { flagValue: input, entry: null };
	}

	// 4. Pin version if specified; otherwise pick the highest version
	//    (numeric compare, not lexical — see compareVersionsDesc). Within a
	//    version tie, break by family-specific variant priority so flagship
	//    selection is deterministic regardless of catalog array order.
	if (pinnedVersion) {
		const versioned = candidates.filter((e) => e.version === pinnedVersion);
		if (versioned.length === 0) {
			// Pinned version not present in catalog — passthrough so the user's
			// explicit choice reaches codex even if the version is stale.
			return { flagValue: input, entry: null };
		}
		versioned.sort((a, b) => mainVariantRank(a.full) - mainVariantRank(b.full));
		return emit(versioned[0]);
	}
	const versions = candidates
		.map((e) => e.version)
		.filter((v): v is string => v !== null);
	if (versions.length === 0) {
		candidates.sort((a, b) => mainVariantRank(a.full) - mainVariantRank(b.full));
		return emit(candidates[0]);
	}
	const uniqueVersions = [...new Set(versions)].sort(compareVersionsDesc);
	const top = uniqueVersions[0];
	const topCandidates = candidates
		.filter((e) => e.version === top)
		.sort((a, b) => mainVariantRank(a.full) - mainVariantRank(b.full));
	return emit(topCandidates[0]);
}

// --- Argv building ----------------------------------------------------------

export interface BuildCodexArgsOptions {
	/** Resolved --model value; null omits the flag (Codex's own default). */
	model: string | null;
	/** Enum-constrained upstream; interpolated as a TOML string value. */
	reasoning: string;
	sandbox: SandboxMode;
	cwd: string;
	/** Extra context dir for --add-dir (full-context exports); null omits. */
	addDir?: string | null;
	/** Defined + valid UUID => resume; undefined/invalid => fresh. */
	sessionId?: string;
	extraArgs: string[];
	prompt: string;
}

/** Build the `codex exec` argv. `codex exec [--json] [opts] "<prompt>"` for
 *  fresh runs, `codex exec resume [opts] <sessionId> "<prompt>"` for
 *  continued ones. Pure function so tests can pin the shape. */
export function buildCodexArgs(opts: BuildCodexArgsOptions): string[] {
	const resumeId =
		opts.sessionId && CODEX_SESSION_ID_RE.test(opts.sessionId) ? opts.sessionId : undefined;

	// stdin is closed (stdio "ignore" upstream) so codex never blocks
	// waiting for a tty.
	const args: string[] = ["exec"];
	if (resumeId) args.push("resume");
	args.push("--json", "--skip-git-repo-check");
	if (opts.extraArgs.length) args.push(...opts.extraArgs);
	if (opts.model) args.push("-m", opts.model);
	// Reasoning effort is passed as a codex `-c key=value` config override.
	// The literal double-quotes are TOML string delimiters (codex parses
	// `-c` values as TOML), NOT shell quoting — shell:false sends them
	// through verbatim. The quotes are required for codex to parse it as a
	// string, not safety.
	args.push("-c", `model_reasoning_effort="${opts.reasoning}"`);
	if (!resumeId) {
		// resume does not accept -C or -s; the session keeps its original
		// cwd and sandbox. Only apply them on fresh runs.
		args.push("-C", opts.cwd, "-s", opts.sandbox);
	}
	// NOTE: -m and -c ARE accepted by `codex exec resume` (verified,
	// codex-cli 0.142.5) and are intentionally sent on continuation runs
	// too — otherwise resume defaults to a different model than the
	// session was recorded with, producing a "session recorded with X
	// but resuming with Y" warning. Keeping -m/-c pins the resumed
	// session to the model the caller requested.
	if (resumeId) args.push(resumeId);
	// `--` ends option parsing so a prompt beginning with a dash (e.g. a
	// task literally starting "--help" or "-v") is treated as the prompt
	// positional, not a codex flag. Verified accepted in both fresh and
	// resume modes (codex-cli 0.142.5).
	if (opts.addDir) args.push("--add-dir", opts.addDir);
	args.push("--", opts.prompt);

	return args;
}

// --- Stream event consumption ----------------------------------------------

function shorten(text: string, limit = 96): string {
	const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
	if (!normalized) return "";
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, limit - 3)}...`;
}

/** True for commands whose output validates the work (test/lint/build/etc).
 *  Used to label progress as "verifying" rather than just "running". */
function looksLikeVerificationCommand(command: string): boolean {
	return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
		command,
	);
}

/** Map an item.started/item.completed event to a short human status line.
 *  Returns null for item types we don't surface (keeps status lean). */
function describeItem(event: CodexEvent, lifecycle: "started" | "completed"): string | null {
	const item = event.item;
	if (!item) return null;
	switch (item.type) {
		case "agent_message":
			// Only the completed agent_message is the answer; surfaced separately
			// as the final result, not as a running status line.
			return null;
		case "reasoning":
			return lifecycle === "completed" && item.text
				? `thinking: ${shorten(item.text)}`
				: null;
		case "command_execution":
			if (lifecycle === "started") {
				const verb = looksLikeVerificationCommand(item.command ?? "")
					? "verifying"
					: "running";
				return `${verb}: ${shorten(item.command ?? "")}`;
			}
			return `command ${item.status ?? "done"}: ${shorten(item.command ?? "")} (exit ${item.exit_code ?? "?"})`;
		case "file_change": {
			const paths = (item.changes ?? []).map((c) => c.path);
			if (paths.length === 0) return null;
			const verb = lifecycle === "started" ? "editing" : "edited";
			return `${verb}: ${shorten(paths.join(", "), 140)}`;
		}
		case "mcp_tool_call":
			return lifecycle === "started"
				? `tool: ${item.id}`
				: `tool ${item.status ?? "done"}`;
		case "web_search":
			return lifecycle === "completed" ? `searched: ${shorten(item.query ?? "")}` : null;
		case "todo_list":
			return lifecycle === "completed" ? "plan updated" : null;
		default:
			return null;
	}
}

/** Consume one exec --json event into the state accumulator. */
export function consumeCodexEvent(ev: CodexEvent, st: CodexEventState): void {
	switch (ev.type) {
		case "thread.started":
			// Overwritten on every thread.started: codex echoes the resumed
			// id on continuation runs, so the latest value is authoritative.
			if (ev.thread_id) st.sessionId = ev.thread_id;
			break;
		case "item.started": {
			const line = describeItem(ev, "started");
			if (line && st.statusLines.length < STATUS_LINES_MAX) st.statusLines.push(line);
			break;
		}
		case "item.completed": {
			// Final agent message: capture as the answer.
			if (ev.item?.type === "agent_message" && ev.item.text) {
				st.finalMessage = ev.item.text;
			}
			const line = describeItem(ev, "completed");
			if (line && st.statusLines.length < STATUS_LINES_MAX) st.statusLines.push(line);
			break;
		}
		case "turn.completed":
			if (ev.usage) {
				st.usage = {
					inputTokens: ev.usage.input_tokens ?? 0,
					outputTokens: ev.usage.output_tokens ?? 0,
					reasoningTokens: ev.usage.reasoning_output_tokens ?? 0,
				};
			}
			break;
		case "turn.failed":
			// Surface the failure message; non-zero exit produces the error branch in shaping.
			if (ev.error?.message && st.statusLines.length < STATUS_LINES_MAX) {
				st.statusLines.push(`failed: ${shorten(ev.error.message, 200)}`);
			}
			break;
		case "error":
			// Transient reconnect notices are non-fatal; progress, not failure.
			if (ev.message && st.statusLines.length < STATUS_LINES_MAX) st.statusLines.push(shorten(ev.message, 200));
			break;
	}
}

// --- stderr ----------------------------------------------------------------

/** Drop codex stderr lines that aren't real errors: the stdin-prompt notice
 *  and the PATH-update warning. Modeled on pi-codex's cleanCodexStderr. */
export function cleanCodexStderr(buf: string): string {
	return buf
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter(
			(l) =>
				l &&
				!l.startsWith("Reading additional input from stdin") &&
				!l.startsWith("WARNING: proceeding, even though we could not update PATH:"),
		)
		.join("\n");
}
