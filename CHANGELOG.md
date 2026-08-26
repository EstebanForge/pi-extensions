# Changelog

## 1.7.0 — 2026-08-26

### Added
- **`glm-5.3-flash` support** ([docs](https://docs.z.ai/guides/vlm/glm-5.3-flash)).
  Z.AI's GLM-5.3-Flash shares the 5.3 wire contract (thinking always on,
  `reasoning_effort` `low | high | max`, 1M context, `tool_stream`), with
  two differences the extension now encodes:
  - It is the **first multimodal GLM-5** (native text+image input), so the
    spec table carries a per-model `input` field — flash registers with
    `["text", "image"]`, every other targeted model stays text-only.
  - Both `glm-5.3-flash` and the `glm-5.3-flash[1m]` Coding Plan route are
    targeted; pi 0.84.x ships no built-in flash entry, so seed it in
    `models.json` until pi-ai catches up.
  - The forward-compat fallback regex now matches `-flash` suffixed ids:
    an unknown `glm-5.4-flash` inherits the multimodal flash base instead
    of falling through to Pi's unpatched six-level UI.

### Fixed
- **Published per-token costs are now wired**
  ([pricing](https://docs.z.ai/guides/overview/pricing), per 1M tokens):
  glm-5.2 and glm-5.3 at $1.4 in / $4.4 out / $0.26 cached, flash at
  $0.15 / $0.50 / $0.03 (list prices; z.ai runs a 50% flash promo through
  2026-09-09 — list is the durable baseline, and Coding Plan billing is
  points, so these feed pi's cost display only). Regression fix:
  re-registration used to zero costs, wiping pi's built-in glm-5.2 rates.
- **Corrected the `disabled`-thinking story after a live probe
  (2026-08-26).** The coding endpoint no longer rejects
  `thinking.type: "disabled"` for 5.3+: glm-5.3 honors it (0 reasoning
  tokens), but **flash silently converts it to lightweight thinking and
  bills it** (7 reasoning tokens on the probe). The request-layer guard
  still rewrites `disabled` to `enabled` + `reasoning_effort: "low"`
  (z.ai's documented migration shape) for every 5.3-family model, so the
  wire stays explicit instead of server-discretionary — the fix is about
  intent and billing, not request survival. Docs and comments updated;
  behavior unchanged for glm-5.2.

## 1.6.0 — 2026-08-21

### Added
- **`zai_web_search` tool: live web search through Z.AI's Web Search MCP
  endpoint, with no MCP server required.** Z.AI exposes Coding Plan web
  search as a remote streamable-HTTP MCP server
  (`api.z.ai/api/mcp/web_search_prime/mcp`, tool `web_search_prime`;
  [docs](https://docs.z.ai/devpack/mcp/search-mcp-server)) that clients
  normally wire through an MCP configuration. The extension now speaks the
  MCP JSON-RPC protocol directly over `fetch` (`lib/zai-search.ts`), so the
  tool ships inside pi with zero MCP setup and searches bill against the
  GLM Coding Plan search quota, same as the official MCP path.
  - Protocol details probed live and encoded in the client: initialize →
    `notifications/initialized` → `tools/call`; responses are SSE-framed
    JSON-RPC (plain JSON bodies also accepted — both are parsed); the
    session id rides the `mcp-session-id` response header; the server's SSE
    `id:` line can disagree with the JSON-RPC body id, so messages are
    matched on the body; negotiated protocol version (2024-11-05) is echoed
    back via `MCP-Protocol-Version`; the result `content[0].text` is
    DOUBLE-encoded JSON (a JSON string wrapping the JSON array of results)
    and both layers are unwrapped.
  - The MCP session is cached for the process lifetime; concurrent first
    calls dedupe through a shared handshake promise; on session loss (HTTP
    404/410, 400/JSON-RPC errors mentioning the session) the client drops
    the cached id, re-initializes once, and retries. Non-session errors
    propagate without a retry.
  - Key reuse: the tool resolves the same key as the provider (pi auth
    storage: `/login`, `models.json` apiKey, `ZAI_API_KEY`), with a raw
    env-var fallback so it works even without a `zai` provider configured.
    A missing key fails the call visibly with the opt-out hint instead of
    returning a fake empty result set.
  - Parameters map 1:1 to the server schema (which is
    `additionalProperties: false`): `query` → `search_query`, `recency` →
    `search_recency_filter` (`oneDay|oneWeek|oneMonth|oneYear|noLimit`),
    `domain` → `search_domain_filter`, `contentSize` → `content_size`
    (`medium|high`), `location` (`cn|us`). Undefined optionals are dropped.
    45s hard timeout per call (combined with pi's cancellation signal via
    `AbortSignal.any`). ~10 results per search.
  - **New flag `glm-web-search` (default ON, user request):** registers the
    tool out of the box; users running a different search provider opt out
    with `/glm-tweaks glm-web-search` and the tool disappears after the
    reload. The flag joined the single-source-of-truth `FLAGS` list, so it
    surfaces in `pi config`, the `/glm-tweaks` menu/status/autocomplete for
    free.
- `@earendil-works/pi-ai` and `typebox` declared as optional peer
  dependencies (pinned as devDependencies for typecheck; pi provides both
  at runtime), matching the pattern already used by pi-ask-* and pi-git-me.
- Tests: MCP client protocol suite with a fake fetch (SSE/JSON parsing,
  id matching, double-decode, session reuse across calls, header
  propagation, 404 and JSON-RPC session-loss retry, non-session error
  propagation, isError surface, initialize failure) plus tool gating
  (registered by default, absent when opted out) and the no-key visible
  failure.

### Verified
- Live end-to-end through the shipped client code: first search 9 results
  in ~2.8s (includes handshake), second search 10 results in ~1.7s
  (cached session, no re-initialize). Re-verified after the peer-review
  fixes below.

### Notes
- **Peer-reviewed** (Claude Sonnet, read-only): three findings, all fixed.
  - Handshake failures (bad key, endpoint down) were misclassified as
    session errors — the error messages embed the word "initialize", which
    the retry matcher keyed on — so a permanent auth failure burned a
    doubled handshake (4 POSTs instead of 2). The matcher now keys on
    "session" only; a failed handshake is never retryable.
  - The session-reset retry path raced under concurrent calls: N parallel
    searches on a dead session could each reset + re-handshake, and one
    call could tear down a sibling's fresh session. The reset is now
    compare-and-clear against the handshake generation the failing call
    ran on: exactly one caller refreshes, siblings reuse the new session.
  - Result items were validated on `link` only; an item with a link but
    missing `title`/`content` survived the filter and crashed the formatter
    with a raw TypeError. All three fields are now validated (malformed
    items are dropped, and a fully-malformed payload still fails visibly).
  - New regression tests pin all three: bad key → exactly one handshake
    and zero tool calls; two concurrent searches on a dead session →
    exactly 2 handshakes and 4 tool calls total; malformed-item filtering.
  - Comment fixes: client lifetime is per factory load (/reload discards
    it; sessions are intentionally not torn down — server-side TTL reaps),
    and the requested-vs-negotiated protocol version is documented at the
    constant.

## 1.5.0 — 2026-08-21

### Added
- **`openai (api usage)` route: the standard z.ai platform API** at
  `https://api.z.ai/api/paas/v4` (per-token billing). The route setting now
  offers three labeled options — `openai (coding plan)` (default, Coding
  Plan credits), `openai (api usage)` (standard API, per token), and
  `anthropic` — instead of the bare `coding` / `anthropic` pair. The
  settings menu, `/glm-tweaks` status panel, and tab-completions show the
  labels; the persisted value keeps the short keys (`coding` | `api` |
  `anthropic`) so pre-existing settings files load unchanged.
  - Same OpenAI Chat Completions thinking contract as the coding route
    (`thinking.type` + `reasoning_effort` + `clear_thinking: false` +
    verbatim `reasoning_content` replay); only the endpoint and who bills
    you differ. Preserved Thinking defaults OFF server-side on the standard
    API, but the explicit `clear_thinking: false` enables it, so the cache
    posture matches the coding route.
  - **Key caveat**: z.ai keys are not interchangeable — the api route needs
    a standard platform API key, not the Coding Plan key.

### Changed
- **`glm-budget-nudge` now defaults OFF** (user request): cache-neutral is
  not behavior-neutral — the flag rewrites the system prompt for every
  targeted GLM turn, so stock behavior is the safer default. All three
  token-efficiency flags now default OFF; existing users who explicitly
  toggled the flag keep their persisted choice (persisted-wins). Note for
  upgraders whose 1.2.0-era toggle coincidentally matched the old default:
  a persisted `true` still wins — run `/glm-tweaks glm-budget-nudge` once
  to turn it off. Also documented: the nudge targets GLM-5.2's
  overthinking loop and is not recommended for GLM-5.3+, whose
  post-training already fixed it.
- **Top thinking tier renamed from `xhigh` to `max`.** z.ai's wire values
  for glm-5.2 and glm-5.3+ are `low | high | max`
  ([docs](https://docs.z.ai/guides/llm/glm-5.3)), and Pi ships a native
  `max` thinking level, so the picker, Shift+Tab cycling, and `/thinking`
  now show `max` ("Maximum reasoning") for the deep-reasoning tier instead
  of the misnamed `xhigh`.
  - `xhigh` is now hidden (`null`) on every targeted GLM spec, exactly like
    the other non-wire levels; `max: "max"` carries the wire value it
    always had. Same bytes on the wire — display-only rename.
  - The `model_select` auto-clamp now bumps to the nearest visible level at
    or above the hidden one (mirroring pi-ai's `clampThinkingLevel`
    up-first rule) instead of always landing on `high`: a session persisted
    at `xhigh` upgrades to `max`, preserving its effort tier and wire
    behavior across the upgrade.
  - Footer chip, clamp notification, and the `/glm-tweaks` status line were
    already wire-labeled (`max`), so they are unchanged.

### Fixed
- **Footer chip re-seeded on every `session_start`** (user-reported):
  pi's interactive mode clears ALL extension footer statuses via
  `resetExtensionUI()` on `/reload`, `/new`, and `/resume`, and
  `model_select` does not re-fire when the model is unchanged — so the
  chip vanished on session switch or after any `/glm-tweaks` toggle
  reload until the next manual model switch. Both hooks now share
  `updateFooterChips()`. Consolidated to ONE compact chip — `⇢ OAI` /
  `⇢ ANT` (single-width monochrome glyph, U+21E2 ⇢ rightwards dashed arrow (verified in Iosevka Nerd Font Mono; earlier candidates U+26D7/U+26D5/🛣 are absent from mainstream terminal fonts), not a double-width emoji; the
  symbol marks the chosen route), shown only while a targeted GLM
  model is selected: the separate thinking-levels chip was redundant with
  the model line's `• <level>` and the `/thinking` picker, and a single
  entry keeps the extension-statuses footer line uncluttered. Inline
  placement in the bottom-right model segment is not possible via the
  extension API (`FooterComponent` hardcodes it).
- **Anthropic-route fallback is now spec-aware** (peer-review finding):
  an unmapped Pi level used to hardcode `reasoning_effort: "low"`, but
  glm-5.2 does not document a `low` tier (wire: `high` | `max`) — a 5.2
  session at level `off` on the anthropic route could send an undocumented
  effort. The fallback (and the `glm-skip-short-thinking` anthropic path)
  now uses the lightest effort the spec actually maps: 5.2 → `high`,
  5.3 → `low`.
- `nextVisibleLevel`'s unknown-level fallback now derives from the spec's
  visible levels instead of returning a hardcoded `"high"`.

## 1.4.0 — 2026-08-19

### Added
- **API route selection (`glm-api-route`: `coding` | `anthropic`).** Both
  z.ai GLM Coding Plan protocols are now user-selectable per installation
  (same key, same credits — [docs](https://docs.z.ai/devpack/quick-start)):
  - `coding` (default, unchanged): OpenAI Chat Completions at
    `api.z.ai/api/coding/paas/v4` with implicit prefix caching and the
    documented `thinking` + `reasoning_effort` contract.
  - `anthropic`: Anthropic Messages at `api.z.ai/api/anthropic`, activating
    Pi's native `cache_control` breakpoints. Verified by live probe: a
    repeated ~122k-token prefix read 122,560/122,581 tokens from cache.
    Thinking is translated per-request to z.ai's probed shape
    (`thinking: {type: "enabled", reasoning_effort: "low|high|max"}` —
    nested, never `disabled`, which the endpoint silently ignores).
  - Switch via `/glm-tweaks route <coding|anthropic>` or the interactive
    menu; applied through the existing persist + reload path.
- Footer chip showing the active route (`OAI` / `ANT`) next to the thinking
  chip, cleared on non-GLM model select.
- `lib/flag-settings.ts` widened to `boolean | string` values
  (`loadSettings` / `loadStringSettings` / `saveSetting`); pre-1.4 settings
  files load unchanged.
- Tests for route registration, thinking replacement, the
  disabled-silent-ignore hazard, coding-route isolation, and the
  cross-session settings-flip regression.

### Notes
- **Peer-reviewed** (two rounds): the anthropic request-shape branch keys
  off the registered model's `api` field, not a fresh settings read, so a
  concurrent pi session flipping the route on disk cannot miswire another
  session's requests. `supportsLongCacheRetention` is pinned `false` on the
  anthropic route until z.ai documents `ttl:"1h"`.
- The anthropic route reports `cache_read_input_tokens` but no
  `cache_creation_input_tokens`, so Pi's cache-write column reads 0 there
  (display only; cached tokens still bill at the discounted rate).
- Switching routes mid-conversation replays prior turns' reasoning as plain
  text (Pi degrades thinking blocks without signatures on replay); start a
  fresh session for a clean A/B.

## 1.3.0 — 2026-08-14

### Added
- **GLM-5.3 support.** New `MODEL_SPECS` table drives everything: the
  extension now patches `glm-5.2`, `glm-5.3`, and the 1M-context
  `glm-5.3[1m]` Coding Plan route, each with its own thinking map. GLM-5.3
  removed `thinking.type: "disabled"` (direct API rejects it) and added a
  real `low` wire level, so 5.3 maps Pi `off`/`low` to
  `thinking enabled + reasoning_effort: "low"` (z.ai's documented
  migration) and hides `minimal`/`medium`. Footer hint and clamp messages
  are derived per model (`low | high | max` on 5.3, `off | high | max` on
  5.2).
- `glm-skip-short-thinking` on 5.3 now forces `enabled` + `low` instead
  of the rejected `disabled`.
- Tests: session_start registration coverage for the multi-spec build
  (5.3 map, pass-through of untargeted models, no-op when no target).
- **Forward compatibility for glm-5.4+.** `resolveSpec()`: an unknown
  `glm-5.N` with N >= 3 (including `[1m]`) inherits the glm-5.3 spec, so a
  rushed 5.4 release works day one. Explicit `MODEL_SPECS` entries always
  win; glm-4.x and future glm-6 are excluded (unknown wire contracts).
- **Request-layer `disabled` guard for 5.3+** (peer-review fix): Pi's zai
  transport (openai-completions.js) sends `thinking.type:"disabled"`
  whenever the reasoning effort is undefined — exactly the Pi level-`off`
  path — and the model's `thinkingLevelMap` is never consulted there, so
  the map's `off:"low"` entry alone could not prevent a rejected request.
  `before_provider_request` now unconditionally rewrites `disabled` to
  `enabled` + `reasoning_effort:"low"` on any spec with
  `canDisableThinking: false`. New test exercises the wire payload
  directly (5.3 rewritten, 5.2 untouched).

## 1.2.1 — 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent`, `pi-tui` dev pins to `^0.84.0`. Audited against the pi v0.84.0 breaking changes (renamed `ModelsRequestTransforms`, null-tolerant `getApiKeyAndHeaders` headers, dropped `message_update` partial fields, v4 session APIs); no code changes were needed and `tsc`/`typecheck` passes against 0.84.0.

## 1.2.0 — 2026-07-23

### Changed
- **Token-efficiency flags rebalanced for cache safety.**
  `glm-clear-thinking` and `glm-skip-short-thinking` now default OFF, and
  `glm-budget-nudge` defaults ON but cache-safe. All three shipped defaulting
  to ON in 1.1.x, and each broke the z.ai server cache in a different way.
  Per [z.ai Thinking Mode docs](https://docs.z.ai/guides/capabilities/thinking-mode),
  Preserved Thinking (`clear_thinking: false`) is **on by default on the
  coding endpoint** specifically because it "increases cache hit rates —
  saving tokens in real tasks" by keeping `reasoning_content` byte-identical
  across turns.
  - `glm-clear-thinking` forced `clear_thinking: true`, stripping
    `reasoning_content` each turn so the next-turn prefix no longer
    byte-matched the server cache (full re-bill, e.g. "Cache miss: 140k
    tokens re-billed"). Now defaults OFF.
  - `glm-budget-nudge` rewrites the system prompt every turn and (in 1.1.x)
    appended a reactive `[system reminder: ...]` user message after the last
    tool result when the ratchet fired. The constant fragment append is
    cache-safe on its own; the ratchet is not (see Removed), so the ratchet
    is gone and the flag keeps just the fragment, defaulting ON.
  - `glm-skip-short-thinking` toggles `thinking.type` between `enabled` and
    `disabled` turn-to-turn (request-shape change). Now defaults OFF.

  Existing users who persisted a value via `/glm-tweaks` keep their choice —
  the file-backed store still wins over the default. **Users who never ran
  `/glm-tweaks` were silently running the 1.1.x behavior (fragment + ratchet
  + clear-thinking + skip-short, all ON);** after upgrading they get the
  fragment only. Re-enable the others with `/glm-tweaks` or
  `pi config set <flag> true`.

### Removed
- **Mid-loop ratchet injection deleted.** Previously, when cumulative
  `reasoning_content` in the current agent loop exceeded ~2000 chars, the
  `context` hook appended a `[system reminder: ...]` user message after the
  last tool result to push the model toward a tool call. The hint sat between
  the cached prefix and the model's about-to-generate next turn, displacing
  that turn from the next call's cache-reusable prefix and forcing a
  one-time re-ingest of the fired turn's tokens (a one-shot cost, not a
  per-turn re-bill — the hint was ephemeral and gone from the next call). It
  also fired precisely when reasoning was largest, so it re-ingested the
  biggest block — the opposite of the intent. The upfront system-prompt
  fragment covers the same intent (steer toward a tool call before
  overthinking) without displacing the cached tail, so the reactive ratchet
  is gone. The `RATCHET_THRESHOLD_CHARS` constant and the `loop.ratchetFired`
  field are removed with it.

## 1.1.2 — 2026-07-21

### Fixed
- **Flag toggles no longer crash.** `/glm-tweaks <flag>` and the
  `/glm-tweaks` menu both tried to persist via `pi config set`, which is
  not a real command (`pi config` only accepts `-l/--approve/--no-approve`;
  any positional arg throws "Unexpected argument" and exits 1). Every toggle
  therefore failed with `Failed to apply: <flag>`.
  - Flags now persist to a tiny file-backed store (`<piDir>/pi-glm-tweaks.json`,
    `piDir = PI_CODING_AGENT_DIR || ~/.pi/agent`), seeded into `registerFlag`
    at load. `pi config set` is gone; toggles call `saveFlagSetting` then
    `/reload` (the reload re-seeds the flag from disk).
  - Settings now survive a full pi restart too — the old mechanism never
    persisted at all (extension flags are in-memory only; there is no CLI for
    them).
- New `lib/flag-settings.ts` mirrors the file-backed pattern already proven in
  `pi-asana` and `pi-slack-me`. `lib/` added to the published `files`.

## 1.1.1 — 2026-06-24

### Added
- **`/glm-tweaks` slash command** — in-session flag management.
  - **`/glm-tweaks` (TUI):** opens an interactive `SettingsList` menu — the
    same component `/settings` uses — so users can navigate and flip
    multiple flags in one visit. Changes stage in-memory; a single reload
    fires on close to apply them all.
  - **`/glm-tweaks` (non-TUI / RPC):** falls back to a read-only status
    panel (active model, thinking level vs the `off | high | max` wire map,
    each flag's on/off state). Custom components are terminal-only.
  - **`/glm-tweaks toggle <flag>`** (shorthand: `/glm-tweaks <flag>`):
    one-shot flip — persists via `pi config set`, then reloads.
  - Tab-completion for `toggle` and the three flag names, including after
    a trailing space.
  - Necessitated by the API surface: Pi's extension API exposes `getFlag`
    but no live `setFlag`, so changes persist via `pi config set` and a
    `/reload` picks them up. Flags remain editable via `pi config` / the
    flag editor without the command.
- Consolidated the three flags into a single `FLAGS` source-of-truth const
  (name, label, description) driving `registerFlag`, the menu, autocomplete,
  and the toggle.

### Changed
- Added `@earendil-works/pi-tui` as a devDependency so `SettingsList` /
  `Text` / `Container` / `SettingItem` resolve at type-check time (runtime
  re-aliases to Pi's bundled copy via the extension loader).

### Notes
- **Interactive menu error handling:** the persist loop checks `result.code`
  per flag, collects failures, and errors out without reloading if any
  write failed. Net-zero flips (a flag toggled on then off) are filtered
  against the live value, so reload only fires when something actually
  moved.
- **Intra-loop ratchet:** the `context` hook sums assistant thinking from
  `content[]` `ThinkingContent` blocks (`{type:"thinking", thinking:string}`)
  in the current agent loop, injecting a one-shot hint past ~2000 chars.
  Still needs confirmation against a live zai/glm-5.2 loop where thinking
  actually surfaces in `event.messages`.

## 1.0.0 — 2026-06-24

Initial release. Pi-native tweaks for Z.AI's GLM-5.2.

### Thinking-level UI restriction
- `session_start` hook re-registers `zai/glm-5.2` with the OpenAI-compat
  endpoint (`https://api.z.ai/api/coding/paas/v4`) and a tight
  `thinkingLevelMap` exposing only the three GLM-5.2-supported levels:
  `off`, `high` (Pi `high` → `reasoning_effort: "high"`), and `max` (Pi
  `xhigh` → `reasoning_effort: "max"`). Minimal / low / medium are hidden.
- `model_select` hook auto-clamps a stale hidden level to `high` and
  shows a notification, then sets the footer status to
  `thinking: off | high | max`.
- Native `thinkingFormat: "zai"` so Pi's openai-completions transport
  emits the correct `thinking: { type }` and `reasoning_effort` fields
  without any custom payload rewriting.

### Token-efficiency tweaks
- **`before_agent_start` hook**: appends a soft thinking-budget fragment
  to the system prompt on every zai/glm-5.2 turn (cap thinking at ~500
  tokens, take tool calls every 200-300 thinking tokens). The fragment
  is appended via `event.systemPrompt + fragment` so other extensions
  (pi-go-review, pi-rust-review, CLAUDE.md loaders) still see their
  upstream prompt.
- **`context` hook** (intra-loop ratchet): sums assistant thinking from
  `content[]` `ThinkingContent` blocks in prior messages in the current
  agent loop (the one started by the most recent user prompt). If
  cumulative exceeds ~2000 characters (roughly 500 English tokens),
  injects a one-shot user-side hint to push the model back toward tool
  calls. Fires at most once per loop.
- **`before_provider_request` hook**: per-request payload mutation guarded
  on `ctx.model` so tweaks never bleed onto other models in multi-model
  sessions. Two wirings:
  - Forces `thinking.clear_thinking: true` on every request. The coding
    endpoint defaults to preserved thinking, which silently compounds
    `reasoning_content` across turns. At $4.4/MTok output, this is real
    money saved.
  - On user prompts under 80 chars, forces `thinking.type: "disabled"`
    for that turn. Trivial questions don't need deep thinking.
- **Three Pi-idiomatic flags** (auto-surface in `pi config`):
  - `glm-budget-nudge` (default `true`)
  - `glm-clear-thinking` (default `true`)
  - `glm-skip-short-thinking` (default `true`)

### What the tweaks cannot do
- Cap thinking tokens at a wire level (Z.AI does not expose a budget param).
- Inject text mid-stream (no Pi hook for streaming chunk mutation).
- Force a tool call (system prompt can ask; nothing enforces it).
- Lower `reasoning_effort` per-request — per
  [KiwiGaze/glm-for-copilot #7](https://github.com/KiwiGaze/glm-for-copilot/issues/7)
  it is a no-op on `/chat/completions`.

### Notes
- Idempotent: re-registering on every `session_start` is cheap and keeps
  the model in sync if `models.json` is edited between sessions.
- Auth is untouched — the extension relies on the standard ZAI auth
  resolution (`ZAI_API_KEY`, `/login`, or `models.json` `apiKey`).
- `registerFlag` calls live at the factory top-level (static setup), not
  inside `session_start` — otherwise user preferences would reset on
  every `/new` or `/reload`.
- `baseUrl` is set both at provider level (required by validation) and
  per-model in `GLM52_MODEL` (per-model wins at request time, so any
  custom `baseUrl` the user has on other `zai/*` models is preserved).