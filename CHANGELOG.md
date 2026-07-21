# Changelog

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
