# @estebanforge/pi-glm-tweaks

Pi-native tweaks for Z.AI's **GLM coding models** — `glm-5.2`, `glm-5.3`, `glm-5.3-flash` (the first multimodal GLM-5, native image input), and their 1M-context `[1m]` Coding Plan routes. Restricts the Pi thinking-level UI to the modes each model actually supports on the wire, wires the native `thinkingFormat:"zai"` translation, auto-clamps any stale level when the model is selected, and registers a `zai_web_search` tool that searches the live web through Z.AI's Web Search MCP endpoint — no MCP server setup needed.

## Install

```
pi install npm:@estebanforge/pi-glm-tweaks
```

Works with Pi's built-in `zai/glm-5.2` / `zai/glm-5.3` entries out of the box, or custom entries in `~/.pi/agent/models.json` (pi 0.84.x ships no built-in `glm-5.3-flash` yet — add it to `models.json` until pi-ai catches up). The extension re-registers each targeted model with the OpenAI-compat endpoint and its proper thinking map. Other Z.AI models (`zai/glm-4.7`, `zai/glm-5-turbo`, `zai/glm-5.1`, plus any custom entries) are preserved across the re-registration.

**Forward compatibility:** an unknown `glm-5.N` with `N >= 3` (a rushed `glm-5.4` or `glm-5.4-flash`, say, or their `[1m]` variants) inherits the matching glm-5.3-family spec automatically — plain ids get the text-only 5.3 base, `-flash` ids get the multimodal flash base — so they get the new thinking map on day one instead of Pi's unpatched six-level UI. An explicit entry in the extension's `MODEL_SPECS` table always wins once the real contract is known. glm-4.x and a future glm-6 get no fallback — their wire contracts are unknown, and guessing could send invalid requests.

## What it does

**glm-5.2** ships three thinking modes (per [docs.z.ai](https://docs.z.ai/guides/capabilities/thinking)):

| Pi thinking level | GLM-5.2 wire |
| --- | --- |
| `off` | `thinking: { type: "disabled" }` |
| `high` | `thinking: { type: "enabled" }` + `reasoning_effort: "high"` |
| `max` | `thinking: { type: "enabled" }` + `reasoning_effort: "max"` |

**glm-5.3 / glm-5.3-flash / their [1m] variants** changed the contract (see the [GLM-5.3 launch](https://z.ai/blog/glm-5.3) and [docs](https://docs.z.ai/devpack/latest-model)): thinking is always on (`thinking.type: "disabled"` was removed; probed 2026-08-26, the coding endpoint no longer rejects it — 5.3 honors it, flash silently converts to lightweight thinking and bills it — so the extension rewrites it to `enabled` + `low`, z.ai's documented migration), and the wire levels are `low | high | max` with `max` the default:

| Pi thinking level | GLM-5.3 wire |
| --- | --- |
| `off` | `thinking: { type: "enabled" }` + `reasoning_effort: "low"` |
| `low` | `thinking: { type: "enabled" }` + `reasoning_effort: "low"` |
| `high` | `thinking: { type: "enabled" }` + `reasoning_effort: "high"` |
| `max` | `thinking: { type: "enabled" }` + `reasoning_effort: "max"` |

Pi natively exposes seven thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Neither model fits all seven — on 5.2, `low`/`medium` get mapped to `high` server-side and `minimal` is a no-op; on 5.3, `minimal`/`medium` have no wire counterpart and `off` maps to `low` (z.ai's documented migration for the removed `disabled` type). `xhigh` is hidden on both: z.ai's top wire tier is named `max` ([GLM-5.3 docs](https://docs.z.ai/guides/llm/glm-5.3): `low` / `high` / `max`) and Pi ships a native `max` level, so the picker shows `max` for the deep-reasoning tier instead of the misnamed `xhigh`.

This extension collapses that mismatch:

1. **Re-registers each targeted model** on `session_start` with `api: "openai-completions"`, `baseUrl: https://api.z.ai/api/coding/paas/v4`, `compat.thinkingFormat: "zai"`, and its tight `thinkingLevelMap`. glm-5.2:
   ```ts
   {
     minimal: null,  // hidden
     low: null,      // hidden
     medium: null,   // hidden
     high:   "high", // → reasoning_effort: "high"
     xhigh:  null,   // hidden (wire tier is named max; Pi has a native max level)
     max:    "max",  // → reasoning_effort: "max"
     // off omitted → supported, sends thinking.type = "disabled"
   }
   ```
   glm-5.3 / glm-5.3[1m]:
   ```ts
   {
     off:     "low",  // → thinking stays enabled, reasoning_effort: "low"
     minimal: null,  // hidden
     medium: null,   // hidden
     low:     "low", // → reasoning_effort: "low" (new real wire level in 5.3)
     high:   "high", // → reasoning_effort: "high"
     xhigh:  null,   // hidden (wire tier is named max; Pi has a native max level)
     max:    "max",  // → reasoning_effort: "max"
   }
   ```
2. **Auto-clamps on `model_select`** — if the current level is one we hid (e.g. you switched from a model that allowed `medium`), bump to the nearest visible level at or above it (a stale `xhigh`, the old label for wire `max`, lands on `max`) and notify.
3. **Footer chip** — one compact status while a targeted GLM model is selected: `⇢ OAI` (either OpenAI Chat Completions route: coding plan or api usage) or `⇢ ANT` (Anthropic Messages), rendered on the extension-statuses line of the footer; cleared for every other model. The glyph is a single-width monochrome symbol (U+21E2 ⇢, verified present in Iosevka Nerd Font Mono), not an emoji — emoji render double-width in most terminals and can shift the footer line. It is re-seeded on every `session_start` — pi's interactive mode clears ALL extension footer statuses on `/reload`, `/new`, and `/resume`, and `model_select` does not re-fire when the model is unchanged, so setting it only on model selection made the chip vanish until the next manual model switch. (Inline placement in the bottom-right model segment is not possible: `FooterComponent` hardcodes that side; extensions can only append status lines or replace the whole footer.)
4. **`/glm-tweaks` command** — status panel + flag toggle from inside Pi (see [`/glm-tweaks` command](#glm-tweaks-command)).

`Shift+Tab`, `/thinking`, and the level picker all see only the supported modes for the selected model.

## Token-efficiency tweaks

GLM-5.2 overthinks on long agent loops — it can spend an entire turn on `reasoning_content` without taking a tool call. The Z.AI API does not expose a `max_thinking_tokens` parameter, so the post that popularised this observation does it at the provider layer (mid-stream injection). We can't intercept the stream, but we can approximate the win with three opt-in tweaks.

**`glm-budget-nudge` is a GLM-5.2 remedy and is not recommended for GLM-5.3 or greater.** Z.AI's post-training for 5.3 addressed the overthinking loop ([docs](https://docs.z.ai/guides/llm/glm-5.3): fewer output tokens per task at every effort level than 5.2), so on 5.3+ the fragment only fights the model's tuned behavior. It is not model-gated — if you enable it, it applies to every targeted GLM turn — so leave it off unless you are running 5.2 and seeing the loop.

**All three default OFF (since 1.5.0).** `glm-budget-nudge` is cache-safe — per [docs.z.ai Thinking Mode](https://docs.z.ai/guides/capabilities/thinking-mode), Preserved Thinking (`clear_thinking: false`) is **on by default on the coding endpoint** because it "increases cache hit rates — saving tokens in real tasks," and the nudge's fixed fragment keeps the prefix byte-stable — but cache-neutral is not behavior-neutral: it rewrites the system prompt on every GLM turn. `glm-clear-thinking` and `glm-skip-short-thinking` additionally undermine Preserved Thinking caching. Stock behavior is the safest default; opt in per flag once you have measured that thinking tokens, not cache misses, are your cost driver.

| Flag | Default | What it does |
| --- | --- | --- |
| `glm-web-search` | `true` | Registers the `zai_web_search` tool (see [Z.AI web search tool](#zai-web-search-tool-zai_web_search)). Default ON so search works out of the box; turn it OFF if you run a different search provider, so the model does not see two competing search tools. |
| `glm-budget-nudge` | `false` | Appends a constant thinking-budget fragment to the system prompt on every targeted zai GLM turn, steering the model toward committing to a tool call before it spirals into overthinking. Meant for GLM-5.2's overthinking loop; not recommended for GLM-5.3+, whose post-training already fixed it. **Cache:** safe — the fragment is a fixed string, so the appended system prompt stays byte-identical turn to turn and the cached prefix is reused. (The earlier mid-loop ratchet appended a reactive `[system reminder: ...]` message after the last tool result; that hint sat between the cached prefix and the model's next turn, displacing it from the cache and forcing a one-time re-ingest. It fired when reasoning was largest, so it is gone.) |
| `glm-clear-thinking` | `false` | Forces `clear_thinking: true` on every request, opting out of z.ai Preserved Thinking. Preserved Thinking is the coding endpoint's default and is what keeps the prefix byte-stable across turns (so it caches). Disabling it re-bills the full prefix every turn — usually a net loss. |
| `glm-skip-short-thinking` | `false` | For user prompts under 80 chars, uses the lightest thinking mode for that turn: `thinking.type: "disabled"` on 5.2, `thinking.type: "enabled"` + `reasoning_effort: "low"` on 5.3+ (where `disabled` no longer exists on the wire). **Cache:** toggling thinking intensity across turns based on prompt length changes the reasoning_content sequence z.ai caches, so follow-up turns on the same session re-bill instead of hitting the cached prefix. |

All three flags surface in `pi config` and Pi's flag editor — `pi config set glm-clear-thinking true` to enable one of the opt-ins. Or flip them from inside Pi with `/glm-tweaks`.

## `/glm-tweaks` command

An in-session command for inspecting and flipping the flags above without leaving Pi.

| Invocation | Effect |
| --- | --- |
| `/glm-tweaks` (TUI) | Opens an interactive settings menu (the same `SettingsList` component `/settings` uses). Flip any combination of flags, then a single reload fires on close to apply them all. |
| `/glm-tweaks` (non-TUI / RPC) | Falls back to a read-only status panel (active model, thinking level vs the `off \| high \| max` map, and each flag's on/off state). |
| `/glm-tweaks toggle <flag>` | One-shot flip: persists, then reloads. |
| `/glm-tweaks <flag>` | Shorthand one-shot toggle (flag name without the `toggle` keyword). |
| `/glm-tweaks route <coding\|api\|anthropic>` | Switch the z.ai API route for targeted GLM models (full labels like `openai (coding plan)` also accepted): persists, then reloads. |

The command offers tab-completion for `toggle` and the three flag names.

**Why a reload per apply.** Pi's extension API exposes `getFlag` but no live `setFlag`, and flag values are read into memory at load time. So changes persist via `pi config set` and a `/reload` picks them up. The interactive menu stages all your flips and reloads once on close; the one-shot toggle reloads immediately. In both cases the command notifies (`Applied 2 change(s). Reloading...`) before reloading. If you'd rather avoid reload churn entirely, set flags directly in `pi config` / the flag editor and reload once at your convenience.

### What the tweaks cannot do

- Cap thinking tokens at a wire level. Z.AI does not expose a thinking budget param.
- Inject text mid-stream. No Pi hook for streaming chunk mutation.
- Force the model to call a tool. The system prompt can ask; nothing forces it.
- Lower `reasoning_effort` per-request. Per [KiwiGaze/glm-for-copilot #7](https://github.com/KiwiGaze/glm-for-copilot/issues/7) it's a no-op on `/chat/completions`.

## Z.AI web search tool (`zai_web_search`)

Z.AI ships Coding Plan web search as a remote MCP server ([docs](https://docs.z.ai/devpack/mcp/search-mcp-server)) that clients normally wire up through an MCP configuration. This extension speaks the MCP JSON-RPC protocol to that endpoint directly over HTTPS (`lib/zai-search.ts`), so the `zai_web_search` tool works with zero MCP setup: initialize handshake once per process, then one `tools/call` per search. The MCP session is cached and re-established automatically if the server evicts it; results bill against the GLM Coding Plan search quota, exactly like the official MCP path.

The tool uses the already-configured Z.AI key (same resolution as the provider: `/login`, `models.json` apiKey, or `ZAI_API_KEY`), works with any model — not just GLM — and fails visibly with the opt-out hint when no key exists. Each search has a 45s timeout. Searches return ~10 results (page title, URL, content summary).

Parameters (mapped to the server's `web_search_prime` schema):

| Parameter | Wire field | Values |
| --- | --- | --- |
| `query` | `search_query` | free text; keep under ~70 chars for best results |
| `recency` | `search_recency_filter` | `oneDay` `oneWeek` `oneMonth` `oneYear` `noLimit` (default `noLimit`) |
| `domain` | `search_domain_filter` | one domain, e.g. `docs.z.ai` |
| `contentSize` | `content_size` | `medium` (~400-600 words/result, default) or `high` (~2500 words, higher quota cost) |
| `location` | `location` | `cn` (server default) or `us` |

Toggle with `/glm-tweaks glm-web-search` (default ON; a reload applies it, and the tool appears/disappears on the next turn). Wire-level details were probed live and are documented in the code: SSE-framed JSON-RPC responses (plain JSON also accepted), session id in the `mcp-session-id` response header, double-encoded result text, and an SSE `id:` line that can disagree with the JSON-RPC body id (the parser matches on the body).

## API route selection

Three z.ai endpoints, two billing worlds ([docs](https://docs.z.ai/devpack/quick-start), [thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode)):

| Route | Endpoint | Billing | Caching | Thinking |
| --- | --- | --- | --- | --- |
| `openai (coding plan)` (default) | `https://api.z.ai/api/coding/paas/v4` (OpenAI Chat Completions) | Coding Plan credits/points | Implicit server-side prefix caching (Preserved Thinking keeps the prefix byte-identical) | `thinking.type` + `reasoning_effort`, z.ai's documented contract |
| `openai (api usage)` | `https://api.z.ai/api/paas/v4` (OpenAI Chat Completions) | Per token, standard z.ai API key | Preserved Thinking defaults OFF server-side, but Pi sends `clear_thinking: false` explicitly and replays `reasoning_content` verbatim, so the cache posture matches the coding route | Same contract as coding |
| `anthropic` | `https://api.z.ai/api/anthropic` (Anthropic Messages) | Coding Plan credits | Explicit `cache_control` breakpoints (Pi marks system, last tool, last message; verified: a repeated ~122k-token prefix read 122,560 tokens from cache) | `thinking: {type: "enabled", reasoning_effort}` translated per-request by this extension |

The persisted setting keeps the short keys (`coding` | `api` | `anthropic`) for backward compatibility; the labels above are what the settings menu and completions show. Switch with `/glm-tweaks route <key or label>` (or from the interactive menu). **Key caveat for `openai (api usage)`**: z.ai keys are not interchangeable — a Coding Plan key will not bill against the standard API and vice versa, so make sure the configured `zai` provider key matches the route you pick. Notes:

- **Usage display**: the Anthropic route reports `cache_read_input_tokens` but no `cache_creation_input_tokens`, so Pi's cache-write column reads 0 there. The cached tokens still bill at the discounted rate.
- **Mid-conversation switching** is supported but prior turns' reasoning replays as plain text (Pi's Anthropic provider degrades thinking blocks without signatures on replay). Start a fresh session for a clean A/B.
- **The anthropic route never sends `thinking.type: "disabled"`**: z.ai silently ignores it there (the model keeps thinking, nothing errors). The extension always rewrites to `enabled` + the lightest effort, same safety net as the coding route.
- Long cache retention (`ttl: "1h"`) is pinned off on the anthropic route until z.ai documents it; the default 5-minute ephemeral window covers in-session reuse.

## Why this exists

Pi's built-in `thinkingFormat: "zai"` (in `openai-completions.js`) already knows the wire translation. The catch is that a user-defined GLM model in `models.json` typically lacks a `thinkingLevelMap`, so the UI shows all six levels and sends invalid combinations on hidden ones (and on glm-5.3+, a level that maps to `thinking.type: "disabled"` sends a shape the model family no longer documents). This extension fills that gap automatically — no manual `models.json` editing.

## Compatibility

- Pi (`@earendil-works/pi-coding-agent`) — any version with `registerProvider` taking effect post-bind and `thinkingFormat: "zai"` support, plus the `before_agent_start` / `context` / `before_provider_request` / `registerFlag` / `registerTool` hooks.
- Z.AI API key — resolved through Pi's standard auth storage (env var `ZAI_API_KEY`, `/login`, or `models.json` provider `apiKey`). The extension does not configure auth.

## License

MIT