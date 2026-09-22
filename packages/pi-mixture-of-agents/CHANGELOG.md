# Changelog

## 1.0.2 — 2026-09-19

### Fixed
- **Compatibility with pi 0.86.0's normalized provider stream input (broken tool calling).** Stream entry points now receive a branded transcript: `context.systemPrompt` and `context.tools` no longer exist, so the facade passed `undefined` tools to the aggregator (every `moa/<preset>` model lost tool calling) and ran without pi's system prompt. Tools and the base system prompt now come from the transcript via `getCurrentTools` / `getCurrentSystemPrompt`.
- **No duplicate system prompt on the aggregator call.** 0.86.0 folds the system prompt into the transcript's leading system message, but `callAggregator` still passes the public `Context` input shape to `complete()`, so forwarding the transcript verbatim made `normalizeContext` prepend a second copy of the base prompt. `withoutInitialSystemMessage(finalMessages)` strips the folded copy before the call; the aggregator receives exactly one system message: base prompt plus the MoA session instruction. `slots.test.ts` mocks `pi-ai/compat`, so this path has no unit coverage; verified by the facade wiring and the full suite staying green.

### Changed
- Dev pins `pi-coding-agent`, `pi-ai`, `pi-server`, `pi-tui` raised `^0.85.0` to `^0.86.0`. `tsc --noEmit` and the full vitest suite (87 tests) pass against 0.86.0.

## 1.0.1 — 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent`, `pi-ai`, `pi-tui` dev pins to `^0.84.0`. Audited against the pi v0.84.0 breaking changes (renamed `ModelsRequestTransforms`, null-tolerant `getApiKeyAndHeaders` headers, dropped `message_update` partial fields, v4 session APIs); no code changes were needed and `tsc`/`typecheck` passes against 0.84.0.

### Fixed
- **Header type widened to match pi-ai `ProviderHeaders`.** `SlotContext.getApiKeyAndHeaders` declared `headers?: Record<string, string>`; pi v0.84.0 made header values `string | null` (a `null` value is a deletion marker). Widened to `Record<string, string | null>`. Runtime behavior was already correct — headers are forwarded to pi-ai `complete()` unchanged, exactly as v0.84.0 requires — so this is a type-accuracy fix, not a behavior change.

## 1.0.0 — 2026-06-30

Initial release. Ports the Mixture of Agents technique from
[Hermes Agent](https://github.com/NousResearch/hermes-agent)
(`agent/moa_loop.py`) to Pi as an orchestration layer over models already
configured in the user's catalog. Not an LLM; not a provider of models. It
fans out the models you have, synthesizes their outputs, and routes the
result through one of them as the acting model.

### Added

- **Virtual `moa` provider** — presets selectable from `/model` under the
  `Mixture of Agents` provider as `moa/<preset>`. Registered under a unique
  `api` identifier (`"moa"`), not a real api like `"openai-completions"`:
  pi-coding-agent bridges `registerProvider` into pi-ai's global
  `apiProviderRegistry` keyed by `api`, so squatting on a real api would
  clobber that api's dispatch and hijack every model on it.
- **Single `/moa` command, two faces**
  - **`/moa`** — opens a drill-down TUI menu (Browse presets… / New preset…)
    built on `SettingsList` (same component as `/settings`). Browsing a
    preset opens its detail view: aggregator/references (read-only),
    `enabled`, `default`, Edit refs/aggregator…, and Delete…. Enabled and
    default flip in-memory and persist on close with one reload. Falls back
    to a read-only preset listing in headless / `pi -p` mode (custom
    components are terminal-only).
  - **`/moa <prompt>`** — one-shot pass: runs refs + aggregator once over the
    prompt, injects the guidance as a user message, and leaves the active
    model unchanged. Any argument is treated as a prompt, so there are no
    reserved words to collide with; `/moa explain X` and `/moa delete my
    branch` both run as one-shots.
- **Reference fan-out** — N reference models run in parallel
  (`Promise.all`, order preserved) over a trimmed, tool-free, system-prompt-
  free transcript so reference calls stay cheap and survive strict-provider
  rejection. Per-reference failures are tolerated; the error string is
  folded into the guidance and the turn continues with the survivors.
- **Aggregation** — a single model call synthesizes the references into a
  `[Mixture of Agents reference context]` guidance block appended at the
  tail of the last user message. One-shot mode produces advisory guidance
  ("do not answer the user directly"); session mode treats the aggregator as
  the acting model that answers or calls tools directly, with the full tool
  schema intact. Tail-injection keeps the stable prefix byte-stable so
  provider prompt caching is preserved.
- **Searchable model picker** — build and edit presets interactively from
  models already in the catalog, with substring filtering on the full
  `provider/model` string (typing `opus` finds `claude/opus`), rather than
  paging through the whole catalog via `ui.select`.
- **Config layer** — `~/.pi/agent/moa.json` (project override at
  `.pi/moa.json`); project presets override user presets by name. Explicit
  `{provider, model}` slots, so presets mix providers and use multiple
  models from one provider. Per-preset `enabled` switch, `default_preset`
  pointer, and optional `reference_temperature` / `aggregator_temperature` /
  `max_tokens` (defaults 0.6 / 0.4 / 4096). Legacy flat config shape is
  folded into a single `default` preset.
- **Slot resolution via Pi's ModelRegistry** — resolves `{provider, model}`
  pairs through `ModelRegistry.find`, the runtime source of truth that holds
  built-in providers, `models.json` customs, and all `registerProvider`
  extensions. This is required for dynamically registered providers (e.g.
  `claude-bridge` from `pi-claude-bridge`, the virtual `moa` itself) to
  resolve; pi-ai's static `getModel` catalog is build-time frozen and blind
  to them.

### Guardrails

- **Recursion blocked** — reference and aggregator slots cannot be
  `moa:<preset>`. Rejected at config load (`RecursionError`) and runtime-
  skipped with a labelled note (mirrors `moa_loop.py:142`).
- **Per-turn dedup** — references keyed by
  `sha256(advisory_messages) + preset + slot labels`. On retry within the
  same user turn (e.g. a tool-loop iteration), the advisory view is
  unchanged, so cached outputs are reused and the fan-out is skipped
  (mirrors `moa_loop.py:347-369`).
- **`enabled: false`** — per-preset off switch: references are cleared and
  the aggregator runs alone, exactly as if you had selected it as a plain
  model.
- **Abort-aware** — `options.signal` threads into every nested reference and
  aggregator call; Esc cancels in-flight fan-out.

### Notes

- **Aggregator is non-streaming.** Reference calls are non-streaming by
  design; the aggregator is also called via `complete()` and emitted through
  a one-shot `AssistantMessageEventStream`. You see the full answer when the
  aggregator finishes, not token-by-token. Cross-provider streaming
  re-emission is planned for v2.
- **Token cost.** A single model iteration can involve N reference calls
  plus the aggregator call. Mitigate with fewer/smaller reference models,
  `enabled: false` to run the aggregator alone, or per-turn dedup.
- **No weighted voting or routing.** All configured references always run;
  aggregation is pure textual synthesis. (Hermes does the same.)
- **Headless / `pi -p`.** `/moa` falls back to the read-only preset listing
  (the menu and picker are terminal-only). Selecting `moa/<preset>` from
  `/model` works in every mode.
