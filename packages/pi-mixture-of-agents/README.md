# @estebanforge/pi-mixture-of-agents

**Mixture of Agents** for Pi. Registers a virtual `moa` provider (presets selectable in `/model`) and a single `/moa` command that both runs one-shot passes and manages presets through a drill-down menu. Each preset fans out N reference models in parallel over a trimmed transcript, an aggregator synthesizes their outputs into private guidance appended at the message tail, and the aggregator becomes the acting model with the full tool schema intact.

![MoA in Pi](https://github.com/EstebanForge/pi-mixture-of-agents/raw/main/docs/screenshot.png)

Ports the MoA technique from [Hermes Agent](https://github.com/NousResearch/hermes-agent) (`agent/moa_loop.py`). Not an LLM; an orchestration layer over models you already have configured.

## Install

```
pi install npm:@estebanforge/pi-mixture-of-agents
```

Then `/reload` in Pi (or restart), and pick a preset from `/model` under the `Mixture of Agents` provider, use `/moa <prompt>` for a one-shot, or run `/moa` to open the preset menu.

Reference and aggregator models must already be configured in Pi (`~/.pi/agent/models.json` or a provider with credentials). The extension does not ship API keys.

## Commands

Two faces, one command.

| Command | Description |
| --- | --- |
| `/moa` | Open a drill-down menu (TUI): **Browse presets…** (or an empty-state note when none exist) and **New preset…**. Browsing a preset opens its detail view — aggregator/references (read-only), `enabled`, `default`, `Edit refs/aggregator…`, and `Delete…`. One reload per visit. |
| `/moa <prompt>` | One-shot pass: runs refs + aggregator once over your prompt, injects guidance as a user message, and leaves the active model unchanged. Any argument is treated as a prompt, so `/moa explain X` and `/moa delete my branch` both run as one-shots. |

Management (browse / create / edit / delete / enable / set-default) lives as **rows inside the `/moa` menu**, not as typed subcommands, so the one-shot never collides with a reserved word. The menu is a terminal-only `SettingsList` (same component as `/settings`); in headless or `pi -p` mode, `/moa` falls back to the read-only preset listing.

> Slash commands only dispatch in an interactive Pi session (not in `pi -p` print mode). Selecting `moa/<preset>` from `/model` works in every mode.

## How it works

```
┌─ Reference fan-out (parallel) ────────────────────────┐
│  ref A           ref B           ...                    │
│  ↑ no tool schema, no system prompt, trimmed transcript │
└───────────────┬────────────────────────────────────────┘
                │ outputs collected (order preserved, failures tolerated)
                ▼
┌─ Aggregator (single model call) ───────────────────────┐
│  synthesizes refs into guidance → wrapped in           │
│  [Mixture of Agents reference context] block           │
└───────────────┬────────────────────────────────────────┘
                │ appended at TAIL of last user message (cache-safe)
                ▼
┌─ Normal Pi agent loop (aggregator = acting model) ─────┐
│  full tool schema intact → tools, interrupts, turns     │
└────────────────────────────────────────────────────────┘
```

Per iteration when a MoA preset is the active model:

1. **Trim** the transcript to user/assistant text only (no system prompt, no tool schemas, no tool-call/result blocks) so reference calls stay cheap and avoid strict-provider rejections.
2. **Fan out** the reference models in parallel (`Promise.all`, order preserved). Per-reference failures are tolerated; the error string is folded into the guidance and the turn continues with the survivors.
3. **Aggregate** the references into a private guidance block. One-shot mode (`/moa`) synthesizes *advisory* guidance ("do not answer the user directly"); session mode treats the aggregator as the acting model that answers or calls tools directly.
4. **Inject** the guidance at the **tail** of the last user message. The stable prefix (system prompt + history) stays byte-stable, so provider prompt caching is preserved.

## Guardrails

- **Recursion blocked** — reference and aggregator slots cannot be `moa:<preset>`. Rejected at config load and runtime-skipped with a note (mirrors `moa_loop.py:142`).
- **Per-turn dedup** — references are keyed by `sha256(advisory_messages) + preset + slot labels`. On retry within the same user turn (e.g. a tool-loop iteration), the advisory view is unchanged, so cached outputs are reused and the fan-out is skipped (mirrors `moa_loop.py:347-369`).
- **`enabled: false`** — per-preset off switch: references are cleared and the aggregator runs alone, exactly as if you had selected it as a plain model.
- **Abort-aware** — `options.signal` threads into every nested reference and aggregator call; Esc cancels in-flight fan-out.

## Configuration

Presets live in `~/.pi/agent/moa.json` (project override at `.pi/moa.json`):

```json
{
  "default_preset": "default",
  "presets": {
    "default": {
      "reference_models": [
        { "provider": "google", "model": "gemini-2.5-flash" },
        { "provider": "deepseek", "model": "deepseek-v4-pro" }
      ],
      "aggregator": { "provider": "claude-bridge", "model": "claude-opus-4-8" },
      "reference_temperature": 0.6,
      "aggregator_temperature": 0.4,
      "max_tokens": 4096,
      "enabled": true
    }
  }
}
```

Slots are explicit `{provider, model}` pairs, so you can mix providers and use multiple models from the same provider. Run `/moa` and pick **New preset…** to build one interactively from the models already in your catalog; the picker is searchable, so you don't have to page through the whole catalog.

## v1 limitations

- **Aggregator is non-streaming.** Reference calls are non-streaming by design; the aggregator is also called via `complete()` and emitted through a one-shot `AssistantMessageEventStream`. You see the full answer when the aggregator finishes, not token-by-token. Cross-provider streaming re-emission is planned for v2.
- **Token cost.** A single model iteration can involve N reference calls plus the aggregator call. Mitigate with fewer/smaller reference models, `enabled: false` to run the aggregator alone, or per-turn dedup.
- **No weighted voting or routing.** All configured references always run; aggregation is pure textual synthesis. (Hermes does the same.)

## Why this exists

Hermes's own docs report that on their HermesBench, a two-model MoA preset outscores either component model alone: MoA **0.8202** vs `claude-opus-4.8` at 0.7607 vs `gpt-5.5` at 0.7412. The takeaway is that aggregating a second perspective lifts quality on hard tasks rather than just averaging the two. (These are Hermes's published numbers, not benchmarks we ran; see their [Mixture of Agents docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents).)

## Compatibility

- Pi (`@earendil-works/pi-coding-agent`) — any version with `registerProvider` taking effect post-bind, the `session_start` / `session_shutdown` / `model_select` hooks, and `ctx.ui.custom` for the settings menu. `@earendil-works/pi-tui` provides the `SettingsList` component.
- Reference and aggregator models — must already be configured in Pi (`~/.pi/agent/models.json` or a provider with credentials). The extension resolves credentials through Pi's standard auth storage; it does not ship or configure API keys.
- Headless / `pi -p` — `/moa` falls back to a read-only preset listing (the menu and picker are terminal-only). Selecting `moa/<preset>` from `/model` works in every mode.

## License

MIT
