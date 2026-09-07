# Changelog

## 1.0.11 (2026-09-07)

### Fixed
- **A running-but-unhealthy server no longer reads as "not running".** `isServerHealthy` treated any non-2xx from `/agentmemory/health` as "server down", but the engine answers 503 fail-closed under heap-watermark pressure while still serving reads and writes (and 401 on a secret mismatch), so a working server tripped the autostart-disabled bail or, with autostart on, spawned a duplicate. The two "already running" checks in `ensureServer` now fall back to the unauthenticated `/agentmemory/livez` liveness endpoint before declaring the server absent. The post-spawn `waitForHealth` poll stays health-only on purpose: livez answers as soon as the port binds, before engine init finishes, so a fallback there would report success mid-startup.
- **Unreachable-server messages no longer hardcode `http://localhost:3111`.** The `memory_health` tool's failure text and the `/agentmemory` status panel now resolve the configured base URL (`AGENTMEMORY_URL`), so pointing at a LAN host no longer produces a misleading localhost red herring.

### Added
- `tests/extension.test.ts` coverage for `isServerHealthy`: fallback probes (health 503 + livez 200 counts as running; livez unreachable counts as down) and the strict post-spawn path (health 503 is down, livez never asked).

## 1.0.10 (2026-08-26)

### Fixed
- **memory_search and session-start recall now return full memories.** Both previously called the `smart-search` endpoint, which by design returns "compact" title-only results (no narrative field exists in that response), so agents only ever saw ~80-character title fragments with no body. Both call sites now use the `search` endpoint, whose results carry the full observation (title, narrative, type, facts). The response shape is compatible (`results[].observation` + `score`), so `formatSearchResults` needed no change.

## 1.0.9 (2026-08-13)

### Changed
- **Plaintext-HTTP bearer notice no longer renders as a yellow warning.** The startup toast fired at `ui.notify` `warning` level, so pi's TUI pinned it in warning yellow above the input for the whole session, louder than every other startup message. It now fires at `info` level and matches the color of the other initial agent messages (status line, "server started automatically"). The message text is unchanged and still names the risk; `AGENTMEMORY_REQUIRE_HTTPS=1` still throws.

## 1.0.8 (2026-08-12)

### Fixed
- **Plaintext-HTTP bearer warning no longer pins to the screen.** The warning fired via `console.warn`, which lands on stderr; pi's TUI captures stderr and holds it above the input box for the whole session, breaking the layout. It is now routed through `ctx.ui.notify`, the same ephemeral toast path `pi-antigravity-bridge` uses for its lifecycle messages. Headless modes (no UI) keep the `console.warn` fallback. `AGENTMEMORY_REQUIRE_HTTPS=1` still throws.
- **Warning no longer prints twice.** Two entry points trip the guard during `session_start`: the host extension (`index.ts`, via the health check) and the server launcher (`server.ts`, via `isServerHealthy`). Each constructed its own `createPlaintextBearerAuthGuard()`, and the closure's dedupe flag only covers one instance, so both warned. They now share a single `guardPlaintextBearerAuth` singleton in `security.ts` with module-level dedupe, collapsing to one toast per session. `resetPlaintextBearerAuthWarning()` re-arms it each session so `/new` can surface it again.

### Added
- `tests/security.test.ts` covering the shared singleton: cross-call dedupe, `ui.notify` sink routing vs. `console.warn` fallback, per-session reset, loopback/no-secret skips, and the `AGENTMEMORY_REQUIRE_HTTPS=1` throw.

## 1.0.7 — 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent`, `pi-tui` dev pins to `^0.84.0`. Audited against the pi v0.84.0 breaking changes (renamed `ModelsRequestTransforms`, null-tolerant `getApiKeyAndHeaders` headers, dropped `message_update` partial fields, v4 session APIs); no code changes were needed and `tsc`/`typecheck` passes against 0.84.0.

## 1.0.6 (2026-07-21)

### Fixed
- **Flag toggles no longer crash.** The `/agentmemory` menu and one-shot flip
  tried to persist via `pi config set`, which is not a real command (`pi config`
  only accepts `-l/--approve/--no-approve`; any positional arg throws
  "Unexpected argument" and exits 1). Every toggle failed with
  `Failed to apply: <flag>`.
  - Flags now persist to a file-backed store (`<piDir>/pi-agentmemory.json`,
    `piDir = PI_CODING_AGENT_DIR || ~/.pi/agent`), seeded into `registerFlag`
    at load. `pi config set` is gone; toggles call `saveFlagSetting` then
    `/reload` (the reload re-seeds the flag from disk). The default-true
    semantics (`!== false`) are preserved — only an explicit persisted boolean
    overrides the in-code default.
  - Settings now survive a full pi restart too — the old mechanism never
    persisted at all (extension flags are in-memory only; there is no CLI for
    them).
- New `extensions/agentmemory/flag-settings.ts` mirrors the file-backed pattern
  already proven in `pi-asana` and `pi-slack-me`.

## 1.0.5 (2026-06-30)

### Fixed
- Status bar no longer shows `🧠 agentmemory off` for a pressured
  server. The display path only accepted `status === "healthy"`, so a
  working-but-`degraded` server (reachable, reads/writes succeed) read
  as off. A new `classifyHealth` helper routes `healthy`/`degraded`/
  `unhealthy`/`unknown`; `degraded` now shows as `🧠 agentmemory~` (on,
  distinct marker) and `lastHealthOk` is widened so the `agent_end`
  observation hook still fires. `/agentmemory` panel and TUI menu
  surface the real status word plus version.

## 1.0.4 (2026-06-30)

### Fixed
- `memory_delete` no longer deletes an entire session when an agent
  sends an empty `observationIds` array with `kind=observations`. The
  guard now blocks that call up front; previously the body collapsed to
  `{sessionId}` and wiped everything.
- Phantom deletes are reported honestly. The engine returns success for
  non-existent IDs (upstream #833), so the tool now surfaces a 0-count
  warning and sets `ok=false` instead of claiming success.
- Agent-controlled strings (`id`, `observationIds`, `reason`) are
  sanitized before entering the confirm dialog, blocking newline
  injection that could fabricate fake preview lines.
- Prompt guidance tightened: the user must name the specific item in the
  current turn, and the tool steers toward `memory_search` for
  observation IDs instead of falling back to whole-session deletion.

## 1.0.3 (2026-06-30)

### Fixed
- `isServerHealthy` misread a pressured-but-working server as down. The
  engine self-reports `degraded` under memory pressure (RSS watermark, KV
  lag) while still serving reads/writes, but the health check only accepted
  `healthy`/`ok`. Now anything except an explicit `unhealthy`/`down` (or
  missing status) counts as reachable, so a shared pressured server (host +
  construct sandbox) no longer trips the autostart-disabled bail path.

## 1.0.2 (2026-06-24)

### Changed
- **Auto-start is now opt-in (default off).** `agentmemory-autostart` now
  defaults to `false`. Spawning a detached server (and a possible `npx`
  engine download) on every session hung agent startup on slower machines.
  Existing users who relied on the auto-start must enable it once via
  `/agentmemory`, `pi config set agentmemory-autostart true`, or the flag
  editor. The server is still reused if already running (health-check
  detection is unchanged). `agentmemory-npx-fallback` keeps its `true`
  default — it only matters once auto-start is on.

### Added
- **`/agentmemory` slash command.** Modeled on pi-glm-tweaks' `/glm-tweaks`:
  shows server health plus the on/off state of every flag, and flips flags
  via `pi config set` + session reload. Supports `/agentmemory` (interactive
  `SettingsList` menu in the TUI; read-only status panel headless),
  `/agentmemory status`, `/agentmemory toggle <flag>`, and the shorthand
  `/agentmemory <flag>`. Tab-completion covers `toggle`, `status`, and flag
  names.

### Removed
- **`/agentmemory-status` slash command.** Superseded by `/agentmemory`,
  which shows the same server health alongside the flag menu.

## 1.0.1 (2026-06-24)

### Added
- `memory_health` tool now renders a colored status line in the TUI result:
  green ● healthy, red ● unreachable, warning ● otherwise. Uses a custom
  `renderResult`, matching the pi-*-review family's tool-result rendering.
  Adds `@earendil-works/pi-tui` as an optional peer dependency.
- **Auto-start the local server.** On session start and on `memory_search` /
  `memory_save`, the extension health-checks `GET /agentmemory/health` and, if
  down, starts `agentmemory` detached (or `npx -y @agentmemory/agentmemory@latest`
  when the CLI is not on PATH), then polls until healthy. The server outlives Pi,
  so reopening Pi or running a second instance detects the running server and
  never restarts it. Detection is the health check only; no cross-process lock.
  Two opt-out flags (`agentmemory-autostart`, `agentmemory-npx-fallback`, both
  default `true`) surface in `pi config`. New module `extensions/agentmemory/server.ts`.

### Fixed
- `memory_health` execute returned a union `details` shape (`{ ok: false }` |
  `HealthResponse`), which broke the tool's generic and failed `tsc` once peer
  deps resolved. Both branches now carry `ok` (`{ ...health, ok: true }`).
- `context` hook handler type-checked as a TS2769 "no overload" error
  (misreported against the `"input"` overload). The recall message literal
  didn't satisfy the minified `AgentMessage` union; cast `as never`, matching
  pi-glm-tweaks' working `context`-hook pattern. The recall injection itself
  was runtime-correct; this was purely a type fix.
- Both surfaced only once `@earendil-works/pi-coding-agent`, `pi-tui`, and
  `typebox` were resolvable (they are optional peers, so `npm install` never
  pulled them). Verified clean against pi-coding-agent 0.79.8 and 0.80.2.

### Fixed (peer review)
- `server.ts` health-check path now routes through the plaintext-bearer guard
  (`guardPlaintextBearerAuth`) like every other outbound call, so a secret over
  plain HTTP to a non-loopback host warns / fails-closed again (`AGENTMEMORY_REQUIRE_HTTPS=1`).
- `session_start` no longer blocks up to 20s on a cold start: the server start
  is now fire-and-forget (the shared attempt is awaited only by the tools /
  before_agent_start when they actually need it).
- Added a 30s spawn cooldown so a sequential retry after a timeout doesn't
  spawn / `npx`-download a second time while the first is still warming up.
- `runShort` (`agentmemory --version`) now passes `CI=1`, matching the spawn env.

## 1.0.0 (2026-06-10)

Initial release.

- `memory_health` tool: check agentmemory server reachability
- `memory_search` tool: search cross-session memory
- `memory_save` tool: save durable facts to memory
- `/agentmemory-status` command
- `session_start` hook: session ID derivation + health status in footer
- `before_agent_start` hook: auto-recall relevant memories into system prompt
- `agent_end` hook: observe conversation turns back to agentmemory
- Plaintext bearer auth guard via `security.ts`
