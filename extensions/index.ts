/**
 * pi-glm-tweaks — Pi-native tweaks for Z.AI's GLM coding models
 * (glm-5.2, glm-5.3, glm-5.3-flash, and their [1m] variants).
 *
 * Restricts the Pi thinking-level UI to the modes each GLM model actually
 * supports, wires the native `thinkingFormat: "zai"` wire
 * translation, auto-clamps hidden levels, and applies token-efficiency
 * hygiene (per-turn system-prompt nudge, wire-level
 * clear_thinking and skip-short-thinking), and registers a direct
 * zai_web_search tool that speaks Z.AI's remote Web Search MCP
 * endpoint over plain HTTPS — no MCP server setup needed (glm-web-search
 * flag, default ON).
 *
 * Wire map (see https://docs.z.ai/guides/capabilities/thinking and
 * providers/openai-completions.js in pi-ai):
 *
 *   glm-5.2 (thinking can be disabled):
 *     Pi level  | thinking.type | reasoning_effort
 *     ----------|---------------|------------------
 *     off       | "disabled"    | (omitted)
 *     high      | "enabled"     | "high"
 *     max       | "enabled"     | "max"
 *
 *   glm-5.3 / glm-5.3-flash / their [1m] variants (thinking always on;
 *   thinking.type:"disabled" removed in 5.3 — probed 2026-08-26: the
 *   coding endpoint no longer hard-rejects it, it silently converts to
 *   lightweight thinking and bills it; migration is enabled +
 *   reasoning_effort "low"):
 *     Pi level  | thinking.type | reasoning_effort
 *     ----------|---------------|------------------
 *     off       | "enabled"     | "low"   (enforced by the request-layer
 *     low       | "enabled"     | "low"    guard below, NOT the map — Pi's
 *     high      | "enabled"     | "high"   zai transport sends "disabled"
 *     max       | "enabled"     | "max"    whenever effort is undefined)
 *
 * The top tier is Pi's native `max` level, NOT `xhigh`: z.ai names its wire
 * value "max" (docs.z.ai/guides/llm/glm-5.3), Pi ships a matching `max`
 * level, and showing `xhigh` for wire "max" misnames the mode in the UI.
 * `xhigh` is hidden like the other non-wire levels below.
 *
 * Hidden levels are Pi-side concepts that don't map cleanly to the wire
 * (5.2: low/medium map server-side to "high", minimal is a no-op for Pi's
 * reasoning transport; 5.3: minimal/medium have no wire counterpart;
 * both: xhigh has no distinct wire tier under max).
 * Showing them invites accidental footguns.
 *
 * glm-5.3-flash is the first MULTIMODAL GLM-5 (native text+image input,
 * docs.z.ai/guides/vlm/glm-5.3-flash); every other targeted model stays
 * text-only. The spec's `input` field drives that per-model.
 *
 * Behavior:
 *   - On session_start, re-register the `zai` provider with every targeted
 *     GLM model redefined against the OpenAI-compat endpoint and its tight
 *     thinkingLevelMap. registerProvider takes effect immediately after
 *     bindCore (no /reload).
 *   - On model_select to a targeted zai model, clamp a stale hidden level
 *     to a supported one and notify. Set the footer status hint.
 *   - On model_select to any other model, clear the footer status.
 *   - On every user turn, inject a soft system-prompt budget fragment
 *     (`glm-budget-nudge`, default OFF — cache-safe but not behavior-
 *     neutral; see FLAGS below).
 *   - Per LLM call, count cumulative reasoning_content; if over a
 *     threshold, inject a one-shot user-side hint to push the model back
 *     toward tool calls (`glm-budget-nudge`).
 *   - On every outgoing request, force `clear_thinking: true`
 *     (`glm-clear-thinking`, default OFF). The coding endpoint ships Preserved
 *     Thinking ON by default precisely to maximize cache hit rates (see
 *     z.ai Thinking Mode docs); forcing it off re-bills the full prefix
 *     every turn.
 *   - On short user prompts (<80 chars), use the lightest thinking mode
 *     to save tokens on trivial turns (`glm-skip-short-thinking`, default
 *     OFF — toggling request shape turn-to-turn reduces cache hits).
 *     glm-5.2: thinking.type="disabled"; glm-5.3: thinking stays enabled
 *     with reasoning_effort="low" (5.3 rejects "disabled").
 *
 * Auth is untouched. The provider's existing key (ZAI_API_KEY env, /login,
 * or models.json apiKey) continues to resolve against the new baseUrl.
 */
import { getSettingsListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadFlagSettings, loadStringSettings, saveSetting } from "../lib/flag-settings";
import { ZaiMcpSearchClient, type ZaiSearchResult, type ZaiWebSearchArgs } from "../lib/zai-search";

const PROVIDER = "zai";
const ZAI_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
const ZAI_API_BASE_URL = "https://api.z.ai/api/paas/v4";

// API route setting. Three z.ai endpoints, two billing worlds
// (docs.z.ai/devpack/quick-start + docs.z.ai/guides/capabilities/thinking-mode):
//   - "coding" (default): GLM Coding Plan, OpenAI Chat Completions at
//     /api/coding/paas/v4. Billed in plan credits/points. Implicit
//     server-side prefix caching; Preserved Thinking ON by default.
//   - "api": standard z.ai platform API, OpenAI Chat Completions at
//     /api/paas/v4. Billed per token against a standard API key (NOT the
//     Coding Plan key — z.ai keys are not interchangeable). Same thinking
//     contract; Preserved Thinking defaults OFF there, but Pi's zai
//     transport sends clear_thinking:false explicitly and replays
//     reasoning_content verbatim, so the cache posture matches coding.
//   - "anthropic": GLM Coding Plan, Anthropic Messages at /api/anthropic
//     (plan credits, like coding). Pi's Anthropic provider applies
//     cache_control breakpoints (probed 2026-08-19: 122k/122k cached-token
//     read on a repeated prefix). Thinking needs a different translation
//     (see before_provider_request).
// Persisted value is the short key ("coding" | "api" | "anthropic") for
// backward compatibility with pre-existing settings files; the human-readable
// labels below are display-only (settings menu, /glm-tweaks).
type ApiRoute = "coding" | "api" | "anthropic";
const ROUTE_VALUES: ApiRoute[] = ["coding", "api", "anthropic"];
const ROUTE_LABELS: Record<ApiRoute, string> = {
	coding: "openai (coding plan)",
	api: "openai (api usage)",
	anthropic: "anthropic",
};
const ROUTE_SETTING = "glm-api-route";

function resolveRoute(): ApiRoute {
	const persisted = loadStringSettings()[ROUTE_SETTING];
	return persisted === "anthropic" || persisted === "api" ? persisted : "coding";
}

// Per-model tweaks table. One entry per targeted zai model id; everything
// downstream (re-registration, UI hiding, clamping, footer hint, wire
// mutation) derives from this map, so adding the next GLM release is a
// one-entry change (plus whatever z.ai changed on the wire).
interface GlmSpec {
	/** Display name for the re-registered model entry. */
	name: string;
	/** Pi thinking level -> wire reasoning_effort (null = hide in UI). */
	thinkingLevelMap: Record<string, string | null>;
	/**
	 * Whether `thinking.type: "disabled"` is legal for this model. True for
	 * glm-5.2; false for glm-5.3 and glm-5.3-flash. Probed 2026-08-26: the
	 * coding endpoint no longer rejects "disabled" for 5.3+ — 5.3 honors it
	 * (0 reasoning tokens) but flash SILENTLY converts to lightweight thinking
	 * and bills it (7 reasoning tokens on a probe). The request-layer guard
	 * rewrites it to z.ai's documented migration shape (enabled + "low")
	 * either way, so the wire is explicit instead of server-discretionary.
	 */
	canDisableThinking: boolean;
	/** Input modalities. Flash is the first multimodal GLM-5 (text+image). */
	input: ("text" | "image")[];
	/**
	 * Published per-1M-token rates (docs.z.ai/guides/overview/pricing).
	 * LIST prices — flash runs a 50% promo through 2026-09-09; list is the
	 * durable baseline. Coding Plan billing is points, not USD; these drive
	 * pi's cost display/estimate only.
	 */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

// Shared thinking map for every thinking-always-on GLM (5.3 contract:
// off->low, low/high/max wire tiers, the rest hidden). Insertion order is
// load-bearing: lightestEffort() takes the FIRST non-null value, which must
// be the lightest documented effort ("low").
const ALWAYS_ON_MAP: Record<string, string | null> = {
	off: "low",
	minimal: null,
	medium: null,
	low: "low",
	high: "high",
	xhigh: null,
	max: "max",
};

const MODEL_SPECS: Record<string, GlmSpec> = {
	"glm-5.2": {
		name: "GLM-5.2",
		thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
		canDisableThinking: true,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	},
	"glm-5.3": {
		name: "GLM-5.3",
		thinkingLevelMap: ALWAYS_ON_MAP,
		canDisableThinking: false,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	},
	// 1M-context Coding Plan route (same model, bigger window).
	"glm-5.3[1m]": {
		name: "GLM-5.3 (1M)",
		thinkingLevelMap: ALWAYS_ON_MAP,
		canDisableThinking: false,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	},
	// Flash: same wire contract as 5.3, native multimodal input, 3x plan
	// quota (docs.z.ai/guides/vlm/glm-5.3-flash). One-tenth the per-token
	// price of 5.3 (list; 50% launch promo until 2026-09-09).
	"glm-5.3-flash": {
		name: "GLM-5.3 Flash",
		thinkingLevelMap: ALWAYS_ON_MAP,
		canDisableThinking: false,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
	},
	"glm-5.3-flash[1m]": {
		name: "GLM-5.3 Flash (1M)",
		thinkingLevelMap: ALWAYS_ON_MAP,
		canDisableThinking: false,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
	},
};

// Forward-compat fallback: z.ai iterates GLM-5.x fast (5.2 -> 5.3 was one
// month apart, then 5.3-flash two weeks later) and 5.3 set the new contract
// (thinking always on, wire levels low|high|max). An UNKNOWN glm-5.N where
// N >= 3 inherits the matching 5.3-family spec — plain ids inherit the
// text-only 5.3 base, `-flash` suffixed ids inherit the multimodal flash
// base — so a rushed 5.4 (or 5.4-flash) works on day one instead of falling
// back to Pi's unpatched six-level UI. Explicit MODEL_SPECS entries always
// win, so when a new model's real contract is known a one-entry edit
// overrides the fallback. Deliberately NOT applied to glm-4.x or a future
// glm-6: those are unknown contracts, and guessing a wire shape there can
// send invalid requests.
// Note: \d+ also matches multi-digit minors (a hypothetical glm-5.10),
// which correctly sorts above 5.3 numerically — intended.
const FALLBACK_MIN_MINOR = 3;

function resolveSpec(id: string): GlmSpec | undefined {
	const exact = MODEL_SPECS[id];
	if (exact) return exact;
	const m = /^glm-5\.(\d+)(-flash)?(\[1m\])?$/.exec(id);
	if (m && Number(m[1]) >= FALLBACK_MIN_MINOR) {
		const baseId = m[2] ? (m[3] ? "glm-5.3-flash[1m]" : "glm-5.3-flash") : m[3] ? "glm-5.3[1m]" : "glm-5.3";
		return { ...MODEL_SPECS[baseId], name: id };
	}
	return undefined;
}

// Pi thinking levels hidden in the UI for a spec: every map entry mapped to
// null. Listed explicitly in the map so it stays grep-friendly. Note: keys
// merely ABSENT from the map (5.2's "off") are treated as visible by Pi,
// not hidden — absence means "wired elsewhere" (the zai transport sends
// thinking.type="disabled" for it), not "unsupported".
function hiddenLevels(spec: GlmSpec): Set<string> {
	return new Set(Object.entries(spec.thinkingLevelMap).filter(([, v]) => v === null).map(([k]) => k));
}

// Wire-facing labels for the footer hint and the clamp notification. Order:
// "off" first when the spec supports disabling thinking, then the distinct
// reasoning_effort values in map order (5.2: off|high|max, 5.3: low|high|max).
function wireLabels(spec: GlmSpec): string[] {
	const labels = new Set<string>(spec.canDisableThinking && !("off" in spec.thinkingLevelMap) ? ["off"] : []);
	for (const v of Object.values(spec.thinkingLevelMap)) if (v !== null) labels.add(v);
	return [...labels];
}

// Pi's canonical thinking-level ladder, low -> high.
const PI_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Clamp target for a hidden level: the nearest VISIBLE level at or above
// the requested one (then below, if none above exists). Mirrors pi-ai's
// clampThinkingLevel up-first semantics: a stale `xhigh` (the pre-1.5.0
// label for wire "max") lands on `max`, not `high`, so upgrades don't
// silently halve the user's effort tier; `minimal`/`medium` bump to the
// next wire-real level.
function nextVisibleLevel(spec: GlmSpec, level: string): (typeof PI_LEVEL_ORDER)[number] {
	const visible = (l: string) => spec.thinkingLevelMap[l] !== null && spec.thinkingLevelMap[l] !== undefined;
	const idx = PI_LEVEL_ORDER.indexOf(level as (typeof PI_LEVEL_ORDER)[number]);
	if (idx === -1) {
		// Unknown level string: clamp up from the bottom of the ladder so the
		// fallback is itself a visible level, never a hardcoded name.
		for (let i = 0; i < PI_LEVEL_ORDER.length; i++) if (visible(PI_LEVEL_ORDER[i])) return PI_LEVEL_ORDER[i];
		return "high"; // unreachable: every spec maps at least one level
	}
	for (let i = idx; i < PI_LEVEL_ORDER.length; i++) if (visible(PI_LEVEL_ORDER[i])) return PI_LEVEL_ORDER[i];
	for (let i = idx - 1; i >= 0; i--) if (visible(PI_LEVEL_ORDER[i])) return PI_LEVEL_ORDER[i];
	return "high"; // unreachable: every spec maps at least one level
}

// Lightest wire effort a spec documents: the first non-null value in the
// spec's map (insertion order runs light -> heavy: 5.2 high|max, 5.3
// low|high|max). NOT a hardcoded "low" — glm-5.2 does not document a "low"
// effort, so the anthropic-route fallback below must not invent one.
function lightestEffort(spec: GlmSpec): string {
	for (const v of Object.values(spec.thinkingLevelMap)) if (v !== null) return v;
	return "low"; // unreachable: every spec maps at least one effort
}

// Token-efficiency tuning constant. Hardcoded for v1 — exposed as a flag
// would be over-engineering for a single-model extension.
const SHORT_PROMPT_THRESHOLD = 80;

// Extension flags. Single source of truth — drives registerTool gating
// (glm-web-search), registerFlag, the /glm-tweaks status display,
// autocomplete, and the toggle subcommand. The three glm-*-thinking flags
// are token-efficiency tweaks; glm-web-search is a feature toggle.
// The thinking flags default OFF since 1.5.0: glm-budget-nudge is cache-safe
// (it appends a fixed fragment, so the prefix stays byte-identical turn to
// turn and the z.ai server cache is reused) but NOT behavior-neutral — it
// rewrites the system prompt for every GLM turn; glm-clear-thinking and
// glm-skip-short-thinking additionally undermine the coding endpoint's
// Preserved Thinking caching (see docs.z.ai/guides/capabilities/thinking-
// mode). Users who want any of them opt in via /glm-tweaks. glm-web-search
// defaults ON: a working search tool out of the box is the point of the
// feature, and opting out is one toggle (users who run a different search
// provider turn it off so the model does not see two competing tools).
const FLAGS = [
	{
		name: "glm-budget-nudge",
		label: "Budget nudge",
		default: false,
		description:
			"Append a constant thinking-budget fragment to the system prompt on every targeted zai GLM turn (glm-5.2, glm-5.3, glm-5.3-flash, and [1m] variants), steering the model toward committing to a tool call before overthinking. Cache-safe: the fragment is a fixed string, so the appended system prompt stays byte-identical turn to turn and the cached prefix is reused. Defaults OFF since 1.5.0: cache-neutral is not behavior-neutral — it still rewrites the system prompt for every GLM turn, so stock behavior is the safer default and users who want the nudge opt in. Meant for GLM-5.2's overthinking loop; not recommended for GLM-5.3 or greater, whose post-training already fixed the overthinking (fewer output tokens per task at every effort level). (The earlier mid-loop ratchet appended a reactive hint message after the last tool result; the hint sat between the cached prefix and the model's next turn, displacing that turn from the cache and forcing a one-time re-ingest. It fired precisely when reasoning was largest, so it is gone.)",
	},
	{
		name: "glm-clear-thinking",
		label: "Clear thinking",
		default: false,
		description:
			"Force thinking.clear_thinking=true on every request, opting out of z.ai Preserved Thinking. Cache: Preserved Thinking (clear_thinking=false) is the coding endpoint's default because it keeps reasoning_content byte-identical across turns, which is exactly what the server caches; disabling it strips reasoning each turn so the next turn's prefix no longer matches the cache → full re-bill (e.g. 'Cache miss: 140k tokens re-billed').",
	},
	{
		name: "glm-skip-short-thinking",
		label: "Skip short thinking",
		default: false,
		description:
			"For user prompts under 80 chars, use the lightest thinking mode for that turn: glm-5.2 gets thinking.type=disabled; glm-5.3 gets thinking.type=enabled + reasoning_effort=low (5.3 rejects \"disabled\"). Cache: toggles thinking intensity across turns based on prompt length, which changes the reasoning_content sequence z.ai caches; follow-up turns on the same session re-bill instead of hitting the cached prefix.",
	},
	{
		name: "glm-web-search",
		label: "Z.AI web search",
		default: true,
		description:
			"Register the zai_web_search tool: live web search through Z.AI's remote Web Search MCP server (web_search_prime), billed against the GLM Coding Plan search quota. The extension speaks the MCP protocol directly over HTTPS, so no MCP server setup is needed — the configured Z.AI key (ZAI_API_KEY env, /login, or models.json apiKey) is reused. Default ON so the tool works out of the box; turn it OFF if you prefer another search provider (the tool disappears after the reload).",
	},
] as const;

// Soft system-prompt fragment appended to every targeted zai GLM turn when
// the budget-nudge flag is on. No "I'm overthinking" ack string — that's
// unenforceable (model may or may not emit it, may emit it in Chinese,
// and we'd have to detect it).
const BUDGET_FRAGMENT = `

<glm-thinking-budget>
You are operating under a per-turn thinking budget. Behave accordingly:
- Cap each thinking block at ~500 tokens. Don't ruminate; commit to a tool call or response.
- Take a tool call every 200-300 thinking tokens. Don't sit and speculate without acting.
- Prefer a concrete tool call over further internal deliberation.
</glm-thinking-budget>`;

// Build the re-registered model entry for a targeted GLM id. `cost` carries
// the published per-token rates from the spec (see GlmSpec.cost) — the
// pre-1.7.0 zeros wiped pi's built-in glm-5.2 rates on re-registration. thinkingLevelMap doubles as
// UI-hide (`null`) and wire-level mapping on the coding route (Pi's zai
// branch in openai-completions.js reads it); on the anthropic route the map
// still drives UI-hide + clamping, while the wire translation happens in
// before_provider_request (Pi's anthropic provider never consults the map).
// baseUrl is per-model (not provider-level) so we don't override any custom
// baseUrl the user may have set on other `zai/*` models. contextWindow stays
// 1M: glm-5.2 documented 1M, glm-5.3/5.3-flash same base with the [1m]
// Coding Plan route; the base 5.3 standard-API window was unpublished at
// launch. Input modality is per-spec: flash is multimodal, the rest text.
//
// Route differences (see ApiRoute above):
//   - api/baseUrl per route.
//   - coding: thinkingFormat "zai" + zaiToolStream (the documented OpenAI-
//     shape contract, incl. streaming tool-call args).
//   - anthropic: none of that. supportsLongCacheRetention is pinned false —
//     the compat default (true) would add an untested ttl:"1h" to every
//     cache_control marker, and z.ai's endpoint has no documented long
//     retention. 5-minute ephemeral (the no-ttl form) is the probed,
//     working shape.
function buildGlmModel(id: string, spec: GlmSpec, route: ApiRoute) {
	const anthropic = route === "anthropic";
	// "api" and "coding" share the OpenAI Chat Completions contract
	// (thinking shape, reasoning_effort, zai tool streaming); only the
	// baseUrl (and who bills you) differs.
	return {
		id,
		name: spec.name,
		api: anthropic ? "anthropic-messages" : "openai-completions",
		baseUrl: anthropic ? ZAI_ANTHROPIC_BASE_URL : route === "api" ? ZAI_API_BASE_URL : ZAI_CODING_BASE_URL,
		reasoning: true,
		input: spec.input,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		cost: spec.cost,
		thinkingLevelMap: spec.thinkingLevelMap,
		compat: anthropic
			? {
					supportsLongCacheRetention: false,
				// supportsCacheControlOnTools default is fine: the cache probe
				// confirmed system-block breakpoints are honored, and tool-block
				// markers use the same mechanism.
			}
			: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				thinkingFormat: "zai" as const,
				zaiToolStream: true,
			},
	};
}

function specFor(model: { provider: string; id: string } | undefined | null): GlmSpec | undefined {
	return !!model && model.provider === PROVIDER ? resolveSpec(model.id) : undefined;
}

// Build the /glm-tweaks status panel. Read-only snapshot of the active
// model, current thinking level, and the on/off state of every flag.
function renderStatus(
	pi: ExtensionAPI,
	model: { provider: string; id: string } | undefined,
): string {
	const spec = specFor(model);
	const active = spec !== undefined;
	const level = pi.getThinkingLevel();
	const flagLines = FLAGS.map((f) => `  ${pi.getFlag(f.name) === true ? "[x]" : "[ ]"} ${f.name}`);
	return [
		`GLM tweaks — ${active ? `ACTIVE (${model!.provider}/${model!.id} selected)` : "inactive (select zai/glm-5.2, zai/glm-5.3, zai/glm-5.3-flash, or a newer glm-5.x)"}`,
		`thinking: ${active ? `current=${level}, wire=${wireLabels(spec!).join("|")}` : "n/a"}`,
		`api route: ${ROUTE_LABELS[resolveRoute()]}`,
		"",
		"flags:",
		...flagLines,
		"",
		"toggle: /glm-tweaks toggle <flag>   (shorthand: /glm-tweaks <flag>)",
		"route:  /glm-tweaks route <coding|api|anthropic>",
	].join("\n");
}

/**
 * Render search results for the LLM: numbered title + URL + flattened
 * summary. `refer` (Z.AI's internal citation id) is dropped — it carries
 * no information the model can act on.
 */
function formatSearchResults(query: string, results: ZaiSearchResult[]): string {
	if (results.length === 0) return `No web results for "${query}".`;
	const lines = results.map(
		(r, i) => `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.content.replace(/\s+/g, " ").trim()}`,
	);
	return `Web results for "${query}":\n\n${lines.join("\n\n")}`;
}

// zai_web_search timeout. Searches take a few seconds; 45s covers the slow
// tail (contentSize=high) while still failing visibly on a hung connection
// instead of blocking the agent loop forever.
const SEARCH_TIMEOUT_MS = 45_000;

/** Combine the tool's cancellation signal with a hard timeout. */
function withSearchTimeout(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Resolve the Z.AI API key for the search tool. Prefers pi's auth storage
 * (same resolution as the provider: /login, models.json apiKey, or the
 * ZAI_API_KEY env var it reads), then falls back to the raw env var for
 * installs with no zai provider configured at all (the tool is usable
 * with any model, not just GLM). Throws with the opt-out hint when no key
 * exists anywhere — a missing key must fail the call visibly, not return
 * an empty result set.
 */
async function resolveZaiApiKey(ctx: {
	modelRegistry: { getApiKeyForProvider: (provider: string) => Promise<string | undefined> };
}): Promise<string> {
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
		if (key) return key;
	} catch {
		// Provider not configured (no zai entry in the registry) — fall
		// through to the env var.
	}
	const envKey = process.env.ZAI_API_KEY;
	if (envKey) return envKey;
	throw new Error(
		"zai_web_search: no Z.AI API key found. Configure zai auth (/login, ZAI_API_KEY, or models.json apiKey), or turn the tool off with /glm-tweaks glm-web-search.",
	);
}

export default function (pi: ExtensionAPI) {
	// Register Pi-idiomatic flags at factory load time, NOT inside
	// session_start. registerFlag is static setup; calling it per session
	// would clobber user preferences on every /new or /reload. Defaults are
	// seeded from the persisted map in <piDir>/pi-glm-tweaks.json so toggles
	// survive pi restarts; missing/unknown flags fall back to the flag's own
	// `default` (cache-safe: all three token-efficiency flags default off).
	//
	// Persisted-wins is the load-bearing invariant for the v1.2.0 default
	// flip: a 1.1.2 user who explicitly toggled a flag to `true` (even though
	// that matched the old default, so the toggle looked like a no-op at the
	// time) has a real `{ "<flag>": true }` entry on disk today, and
	// `f.name in persisted` picks it up post-upgrade so their explicit
	// choice is preserved. The one-shot toggle handler persists every flip
	// unconditionally (no no-op skip), which is what makes this hold.
	const persisted = loadFlagSettings();
	for (const f of FLAGS) {
		pi.registerFlag(f.name, {
			description: f.description,
			type: "boolean",
			default: f.name in persisted ? persisted[f.name] : f.default,
		});
	}

	// ── zai_web_search tool ─────────────────────────────────────────────
	// Z.AI ships Coding Plan web search as a REMOTE MCP server
	// (api.z.ai/api/mcp/web_search_prime/mcp, tool web_search_prime).
	// Instead of requiring an MCP client setup, we speak the MCP
	// JSON-RPC protocol directly over fetch (lib/zai-search.ts): initialize
	// handshake once per process, then one tools/call per search. Searches
	// bill against the GLM Coding Plan search quota, same as the official
	// MCP path. Gated by glm-web-search (default ON) so users on another
	// search provider can opt out; the gate is evaluated at factory load,
	// and the /glm-tweaks toggle reloads the factory, so the tool appears
	// and disappears on the next turn without a pi restart.
	// registerTool at factory load is supported (pi docs: "works both during
	// extension load and after startup") and the tool is refreshed in the
	// active session immediately.
	if (pi.getFlag("glm-web-search") !== false) {
		// One client per FACTORY LOAD: the MCP session survives across calls
		// within it. /reload re-runs the factory in the same process, which
		// discards the old client without an MCP session teardown — sessions
		// are intentionally not closed (neither here nor on session_shutdown):
		// the server-side TTL reaps them, and a DELETE on every reload would
		// add a round-trip to a code path that must stay fast.
		const searchClient = new ZaiMcpSearchClient();

		pi.registerTool({
			name: "zai_web_search",
			label: "Z.AI Web Search",
			description:
				"Search the live web via Z.AI (web_search_prime). Returns ~10 results: page title, URL, and a content summary. Params: query (keep under ~70 chars); recency (oneDay|oneWeek|oneMonth|oneYear|noLimit, default noLimit); domain (restrict to one domain, e.g. docs.z.ai); contentSize (medium ~400-600 words/result, high ~2500); location (cn|us result region). Uses the GLM Coding Plan search quota.",
			promptSnippet: "Search the live web via Z.AI (zai_web_search)",
			promptGuidelines: [
				"Use zai_web_search for live web lookups (current events, library docs, facts you cannot verify locally). One focused query per topic; refine only if the results miss.",
			],
			parameters: Type.Object({
				query: Type.String({ description: "Search query. Keep under ~70 characters for best results." }),
				recency: Type.Optional(
					StringEnum(["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"] as const, {
						description: "Time range of results. noLimit is the default.",
					}),
				),
				domain: Type.Optional(
					Type.String({ description: "Restrict results to one domain, e.g. docs.z.ai or github.com." }),
				),
				contentSize: Type.Optional(
					StringEnum(["medium", "high"] as const, {
						description: "Summary length per result: medium (~400-600 words, default) or high (~2500 words, higher quota cost).",
					}),
				),
				location: Type.Optional(
					StringEnum(["cn", "us"] as const, {
						description: "Result region: cn (Chinese, server default) or us (non-Chinese).",
					}),
				),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const apiKey = await resolveZaiApiKey(ctx);
				// Wire arguments: only defined optionals are sent — the server
				// schema is additionalProperties:false, but empty strings would
				// also change server behavior (e.g. an empty domain filter).
				const args: ZaiWebSearchArgs = { search_query: params.query };
				if (params.recency) args.search_recency_filter = params.recency;
				if (params.domain) args.search_domain_filter = params.domain;
				if (params.contentSize) args.content_size = params.contentSize;
				if (params.location) args.location = params.location;

				const results = await searchClient.search(args, {
					apiKey,
					signal: withSearchTimeout(signal),
				});
				return {
					content: [{ type: "text", text: formatSearchResults(params.query, results) }],
					details: { query: params.query, count: results.length, links: results.map((r) => r.link) },
				};
			},
		});
	}

	// /glm-tweaks — status display by default; `toggle <flag>` (or bare
	// `<flag>`) flips a boolean. ExtensionAPI exposes no live setFlag, so a
	// toggle is written to <piDir>/pi-glm-tweaks.json (lib/flag-settings.ts)
	// and then reloads the session so registerFlag re-seeds the in-memory
	// default from disk. ctx is stale after reload() — we notify first,
	// reload last, and return immediately.
	pi.registerCommand("glm-tweaks", {
		description: "GLM tweaks: show status, or toggle a flag. Usage: /glm-tweaks [toggle <flag>]",
		getArgumentCompletions: (prefix: string) => {
			// Preserve trailing space: `/glm-tweaks toggle ` (with space) means
			// the `toggle` token is complete and we should now suggest flags.
			// Trimming would collapse it to "toggle" and re-suggest the word.
			const trailingSpace = /\s$/.test(prefix);
			const tokens = prefix.trim().split(/\s+/).filter(Boolean);
			const flagNames = FLAGS.map((f) => f.name);
			const root = ["route", "toggle", ...flagNames];
			// Suggest flag names once `toggle` is complete (either as the only
			// token with a trailing space, or with a partial flag typed).
			// `/glm-tweaks route ` (trailing space) or a partial value:
			// suggest the human-readable labels plus the short keys.
			const routeComplete =
				(tokens.length === 1 && tokens[0] === "route") ||
				(tokens.length >= 2 && tokens[0] === "route");
			if (routeComplete) {
				const partial = tokens.length >= 2 ? tokens[tokens.length - 1] : "";
				const opts = [...ROUTE_VALUES.map((r) => ROUTE_LABELS[r]), ...ROUTE_VALUES];
				const hits = opts.filter((o) => o.toLowerCase().startsWith(partial.toLowerCase()));
				return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
			}
			const toggleComplete =
				(tokens.length === 1 && tokens[0] === "toggle") ||
				(tokens.length >= 2 && tokens[0] === "toggle");
			if (toggleComplete) {
				const partial = tokens.length >= 2 ? tokens[tokens.length - 1] : "";
				const hits = flagNames.filter((n) => n.startsWith(partial));
				return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
			}
			if (tokens.length <= 1 && !trailingSpace) {
				const hits = root.filter((o) => o.startsWith(tokens[0] ?? ""));
				return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// Route mode: `/glm-tweaks route <x>`. Accepts the short key
			// (coding | api | anthropic) or the full label
			// ("openai (coding plan)" | "openai (api usage)" | "anthropic").
			// Persists the canonical key and reloads so session_start
			// re-registers the provider against the new endpoint.
			const routeMatch = /^route\s+(.+)$/.exec(trimmed);
			if (routeMatch) {
				const raw = routeMatch[1].trim().toLowerCase();
				const byKey = ROUTE_VALUES.find((r) => r === raw);
				const byLabel = ROUTE_VALUES.find((r) => ROUTE_LABELS[r] === raw);
				const route = byKey ?? byLabel;
				if (route === undefined) {
					ctx.ui.notify(
						`Unknown route "${routeMatch[1]}". Valid: ${ROUTE_VALUES.map((r) => `${r} (${ROUTE_LABELS[r]})`).join(" | ")}`,
						"warning",
					);
					return;
				}
				if (!saveSetting(ROUTE_SETTING, route)) {
					ctx.ui.notify(`Failed to persist ${ROUTE_SETTING} to settings file.`, "error");
					return;
				}
				ctx.ui.notify(`api route → ${ROUTE_LABELS[route]}. Reloading...`, "info");
				await ctx.reload();
				return;
			}

			// Toggle mode: `/glm-tweaks toggle <flag>` or `/glm-tweaks <flag>`.
			// Direct one-shot flip — persists to the settings file then reloads.
			// Bare `/glm-tweaks toggle` (no flag) falls through to the menu.
			if (trimmed !== "" && trimmed !== "status" && trimmed !== "toggle") {
				const tokens = trimmed.split(/\s+/).filter(Boolean);
				const flagName = tokens[0] === "toggle" ? tokens[1] : tokens[0];
				const meta = FLAGS.find((f) => f.name === flagName);
				if (!meta) {
					ctx.ui.notify(
						`Unknown flag "${flagName}". Valid: ${FLAGS.map((f) => f.name).join(", ")}`,
						"warning",
					);
					return;
				}
				const current = pi.getFlag(meta.name) === true;
				const next = !current;
				if (!saveSetting(meta.name, next)) {
					ctx.ui.notify(`Failed to persist ${meta.name} to settings file.`, "error");
					return;
				}
				ctx.ui.notify(`${meta.name}: ${current} → ${next}. Reloading...`, "info");
				await ctx.reload();
				return;
			}

			// Status/menu mode. In TUI, open an interactive SettingsList
			// (same component /settings uses) so the user can flip several
			// flags in one visit; changes persist to the settings file and a
			// single reload fires on close. Outside TUI (RPC/headless), fall
			// back to the read-only status panel — custom components are
			// terminal-only.
			if (ctx.mode !== "tui") {
				ctx.ui.notify(renderStatus(pi, ctx.model), "info");
				return;
			}

			const active = specFor(ctx.model) !== undefined;
			const pending = new Map<string, boolean | string>();
			const items: SettingItem[] = [
				{
					id: ROUTE_SETTING,
					label: "API route",
					description:
						"z.ai endpoint for targeted GLM models. openai (coding plan): OpenAI Chat Completions at api.z.ai/api/coding/paas/v4, billed in Coding Plan credits; Preserved Thinking on by default. openai (api usage): OpenAI Chat Completions at api.z.ai/api/paas/v4, billed per token against a standard z.ai API key (Coding Plan keys are not interchangeable with standard keys). anthropic: Anthropic Messages at api.z.ai/api/anthropic, Coding Plan credits (cache_control breakpoints, cache reads visible in usage; cache-write is not itemized by z.ai so it shows 0). Switching mid-conversation replays prior turns' reasoning as plain text.",
					currentValue: ROUTE_LABELS[resolveRoute()],
					values: ROUTE_VALUES.map((r) => ROUTE_LABELS[r]),
				},
				...FLAGS.map((f) => ({
					id: f.name,
					label: f.label,
					description: f.description,
					currentValue: pi.getFlag(f.name) === true ? "on" : "off",
					values: ["on", "off"] as string[],
				})),
			];

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				const header = active
					? `GLM tweaks — ${ctx.model!.provider}/${ctx.model!.id} active`
					: "GLM tweaks — inactive (select zai/glm-5.2, zai/glm-5.3, zai/glm-5.3-flash, or a newer glm-5.x)";
				container.addChild(new Text(theme.fg("accent", theme.bold(header)), 1, 1));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Stage the change; persist + reload on close, not here,
						// so the user can flip several settings per visit. The
						// route item stages its enum value verbatim.
						if (id === ROUTE_SETTING) pending.set(id, newValue);
						else pending.set(id, newValue === "on");
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

			// Dialog closed. ctx is still valid here (reload is the only
			// staleness trigger, and we haven't called it yet). Drop net-zero
			// flips (a flag toggled on then off stages but changes nothing),
			// then persist genuine deltas and reload once if any moved.
			// The route item stages its display LABEL; normalize to the
			// canonical key before comparing/persisting so the settings
			// file keeps the short, stable form.
			const routeKeyFor = (v: string): string =>
				ROUTE_VALUES.find((r) => ROUTE_LABELS[r] === v) ?? (ROUTE_VALUES.includes(v as ApiRoute) ? v : "coding");
			const deltas: Array<[string, boolean | string]> = [];
			for (const [name, val] of pending) {
				const current: boolean | string = name === ROUTE_SETTING ? resolveRoute() : pi.getFlag(name) === true;
				const next: boolean | string = name === ROUTE_SETTING ? routeKeyFor(String(val)) : val;
				if (current === next) continue; // net-zero: changed back to current
				deltas.push([name, next]);
			}
			if (deltas.length === 0) return;

			const failures: string[] = [];
			for (const [name, val] of deltas) {
				if (!saveSetting(name, val)) failures.push(name);
			}
			if (failures.length > 0) {
				ctx.ui.notify(`Failed to persist: ${failures.join(", ")}`, "error");
				return;
			}
			ctx.ui.notify(`Applied ${deltas.length} change(s). Reloading...`, "info");
			await ctx.reload();
		},
	});

	// Per-loop mutable state. Node.js runs the extension hooks single-
	// threaded, so a closure-scoped object is safe and avoids re-reading
	// flags + recomputing in every hook. Reset on every before_agent_start.
	const loop: {
		shortPrompt: boolean;
	} = { shortPrompt: false };

	pi.on("session_start", async (_event, ctx) => {
		// Build the full `zai` provider model list, patching only targeted GLM
		// models. registerProvider replaces ALL models for the provider when models
		// are provided, so a single-entry list would silently drop
		// glm-4.7, glm-5-turbo, glm-5.1, and any user-added zai entries.
		const existing = ctx.modelRegistry.getAll().filter((m) => m.provider === PROVIDER);
		if (existing.length === 0) return;
		if (!existing.some((m) => resolveSpec(m.id) !== undefined)) return;

		// registerProvider requires apiKey (or oauth) when defining models,
		// even for a provider that already has auth resolved. Pull the
		// resolved key from the existing provider so we keep working
		// whether the user used ZAI_API_KEY env, /login, or models.json
		// apiKey.
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
		if (!apiKey) {
			ctx.ui.notify(
				"pi-glm-tweaks: ZAI auth not configured. Run `/login` or set ZAI_API_KEY to enable GLM thinking tweaks.",
				"warning",
			);
			return;
		}

		// Per-model spread preserves every original field (api, baseUrl,
		// headers, compat extras) for non-target models. Only targeted GLM
		// models get the new thinkingLevelMap, baseUrl, and OpenAI-compat
		// compat block.
		// baseUrl is set at BOTH provider level (required by validation;
		// satisfies the model-registry check) and per-model in the rebuilt
		// entries (per-model takes precedence at request time, so any custom
		// baseUrl the user has on other `zai/*` models is preserved by
		// the spread).
		const models = existing.map((m) => {
			const spec = resolveSpec(m.id);
			return spec ? buildGlmModel(m.id, spec, resolveRoute()) : { ...m };
		});
		pi.registerProvider(PROVIDER, {
			baseUrl: ZAI_CODING_BASE_URL,
			apiKey,
			models,
		});

	});

	pi.on("before_agent_start", (event, ctx) => {
		// Reset per-loop state at the start of each user turn. The other
		// hooks read this to drive their per-turn behavior.
		loop.shortPrompt = event.prompt.length < SHORT_PROMPT_THRESHOLD;

		if (specFor(ctx.model) === undefined) return {};
		if (pi.getFlag("glm-budget-nudge") !== true) return {};

		// Return the assembled prompt with our fragment appended. We must
		// concat (not replace) — Pi's before_agent_start chaining means
		// our systemPrompt replaces the upstream value, and other
		// extensions downstream only see what we return.
		return { systemPrompt: (event.systemPrompt ?? "") + BUDGET_FRAGMENT };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const spec = specFor(ctx.model);
		if (spec === undefined) return;
		if (!event.payload || typeof event.payload !== "object") return;

		const obj = event.payload as Record<string, unknown>;

		// ── Anthropic route ────────────────────────────────────────────
		// Pi's anthropic provider never consults thinkingLevelMap: it builds
		// budget-based thinking ({type, budget_tokens, display}). z.ai's
		// endpoint takes a different shape (probe 2026-08-19):
		// {type:"enabled", reasoning_effort:"low|high|max"} — effort NESTED in
		// thinking, not top-level (a top-level reasoning_effort is silently
		// ignored there). So this branch REPLACES obj.thinking wholesale;
		// budget_tokens/display are dropped rather than assumed ignored.
		//
		// Never leave type:"disabled" on this route: unlike the coding route
		// (hard reject) z.ai's Anthropic route silently ignores it and thinks
		// anyway — the one failure mode with zero error signal. Tests cover it.
		// Keyed off the REGISTERED MODEL's api field, not a fresh settings
		// read: the model was built at session_start against a specific route,
		// and a concurrent pi session flipping glm-api-route on disk must not
		// change the request shape mid-flight here (the thinking object
		// differs per protocol; the wrong shape on the wrong wire is the
		// silent-failure class this hook exists to prevent).
		if (ctx.model?.api === "anthropic-messages") {
			const level = pi.getThinkingLevel();
			let effort = spec.thinkingLevelMap[level];
			if (effort === null || effort === undefined) {
				// Hidden or unmapped level: glm-5.2 has no "off" key (its off is
				// thinking.type="disabled", unwirable on this route — z.ai's
				// anthropic endpoint silently ignores "disabled"), and 5.3 maps
				// minimal/medium/xhigh to null. Fall back to the lightest effort
				// the spec actually documents (5.2: high, 5.3: low).
				effort = lightestEffort(spec);
			}
			// Short-prompt skip generalizes to the anthropic route: same
			// lightest-documented-effort outcome as the coding branch below.
			if (pi.getFlag("glm-skip-short-thinking") === true && loop.shortPrompt) {
				effort = lightestEffort(spec);
			}
			obj.thinking = { type: "enabled", reasoning_effort: effort };
			return obj;
		}

		// ── Coding route (OpenAI Chat Completions) ────────────────────
		const current = obj.thinking;
		const thinking =
			current && typeof current === "object" && !Array.isArray(current)
				? { ...(current as Record<string, unknown>) }
				: ({} as Record<string, unknown>);

		let mutated = false;

		// 5.3+ safety net: `thinking.type: "disabled"` was removed in glm-5.3.
		// Probed 2026-08-26: the coding endpoint accepts it without error but
		// the outcome is server-discretionary — 5.3 honors it, flash silently
		// converts to lightweight thinking and bills it. Either way the user
		// asked for "off", which no longer exists on the wire.
		// Pi's zai branch (openai-completions.js) sends
		// thinking.type="disabled" whenever reasoningEffort is falsy — which
		// is exactly what Pi level "off" produces, and the model entry's
		// thinkingLevelMap is NOT consulted on that path (it is only indexed
		// by a non-undefined effort). So we cannot fix this in the map; we
		// intercept the payload here and rewrite to z.ai's documented
		// migration shape: enabled + reasoning_effort "low". This runs
		// unconditionally (not flag-gated) because the alternative is an
		// ambiguous request the endpoint may bill against the user's intent.
		if (!spec.canDisableThinking && thinking.type === "disabled") {
			thinking.type = "enabled";
			if (obj.reasoning_effort === undefined) obj.reasoning_effort = "low";
			mutated = true;
		}

		// Opt out of z.ai Preserved Thinking. The coding endpoint ships
		// clear_thinking=false ON BY DEFAULT because preserving reasoning
		// across turns is what makes the prefix cacheable (see z.ai Thinking
		// Mode docs). Flipping this on re-bills the full prefix every turn —
		// hence default OFF and opt-in only.
		if (pi.getFlag("glm-clear-thinking") === true) {
			thinking.clear_thinking = true;
			mutated = true;
		}

		// Short-prompt thinking-skip: trivial turns ("what time is it")
		// don't need deep thinking. glm-5.2: force the kill switch and let
		// Pi's zai branch drop the thinking.type="disabled" through.
		// glm-5.3: "disabled" is rejected — thinking stays enabled with
		// reasoning_effort="low" (z.ai's documented migration path).
		//
		// Intentionally applies to every LLM call in the loop, not just the
		// first: loop.shortPrompt is computed once from the initial prompt
		// and held constant (see before_agent_start). A short prompt that
		// spawns tool calls stays light for the whole turn.
		if (pi.getFlag("glm-skip-short-thinking") === true && loop.shortPrompt) {
			if (spec.canDisableThinking) {
				thinking.type = "disabled";
			} else {
				thinking.type = "enabled";
				obj.reasoning_effort = "low";
			}
			mutated = true;
		}

		if (mutated) {
			obj.thinking = thinking;
		}
		return obj;
	});

	pi.on("model_select", (event, ctx) => {
		const spec = specFor(event.model);
		if (spec === undefined) return;

		// Auto-clamp if Pi's current level is one we hid for this model.
		// setThinkingLevel is a no-op if already at the requested level.
		const current = pi.getThinkingLevel();
		if (hiddenLevels(spec).has(current)) {
			const clamped = nextVisibleLevel(spec, current);
			pi.setThinkingLevel(clamped);
			ctx.ui.notify(
				`${event.model.id} thinking: "${current}" not supported. Switched to ${clamped} (${wireLabels(spec).join(" | ")}).`,
				"info",
			);
		}

	});
}