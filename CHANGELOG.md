# Changelog

All notable changes to this project will be documented in this file.

## [1.0.2] - 2026-09-10

### Changed

- **Default permission mode is now `full` (was `read`).** Delegated Claude runs get full tool access (file edits + bash via `--permission-mode bypassPermissions`) with no permission prompts, matching pi's own no-gate philosophy: pi has none either. `read` stays as the restrictive mode (read-only tool allowlist) and `none` as the zero-tools mode; both remain per-call overrides or `defaultMode` in `~/.pi/agent/ask-claude.json`. `allowFullMode` still gates `full` (default on) and the read-only allowlist fallback inside `buildClaudeArgs` is unchanged.

### Fixed

- The TUI result renderer compared modes against the old default (`read`), so default runs gained a redundant mode tag while non-default runs rendered untagged. It now compares against `DEFAULT_MODE`.
- The README Configuration section still documented `defaultMode: "read"` after the modes table was updated; the example JSON and the defaults table now say `full`.

## [1.0.1] - 2026-08-13

### Added

- **Model and thinking effort shown next to the tool name.** While a
  delegation runs, the TUI now renders
  `AskClaude [model=sonnet, thinking=high]` with a prompt preview, plus a
  tidy result row (`✓ AskClaude 12.3s`) with an expandable body. Built on
  pi's `renderCall`/`renderResult` hooks; the values shown are the resolved
  config defaults, not just the args the caller passed.
- **Opt-in full-context delegation (`includeContext`).** New boolean param
  (default `false`, isolated one-shot unchanged). When `true`, the current pi
  conversation is exported as resolved markdown to
  `~/.pi/extensions-data/estebanforge/pi-ask-claude/` and the prompt tells
  Claude to read it first. The temp file is removed after the run.

## [1.0.0] - 2026-08-12

Initial release.

### Added

- **`AskClaude` tool** - delegates a self-contained sub-task to the
  [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI via
  `claude -p --output-format stream-json`, streams structured progress
  events (reading / searching / editing / running / web) as partial output,
  and returns the final agent message. The tool answers to the names the
  CLI is known by - **claude** and **claude code** - surfaced in its
  description so the model maps "ask claude" to this single tool. This is
  the Claude-Code-specific standalone, distinct from the SDK-backed
  `AskClaude` in `pi-claude-bridge` (see Conflict guard below).
- **Multi-turn conversations with Claude Code** - optional `sessionId`
  param. Omit for a one-shot (Claude starts a fresh session); pass the id
  returned in a prior call's result (`details.sessionId`, also shown in the
  result footer) to resume that session with full context. The agent
  decides per call which mode to use. Fresh runs let Claude assign the id
  and capture it from the `system/init` stream event; `claude --resume <id>`
  continues it natively. Claude holds all session state on disk; the
  extension is otherwise stateless.
- **Structured progress** - unlike plain stdout capture, the extension
  parses the stream-json JSONL stream and renders human-readable status:
  `reading: …`, `searching: …`, `editing: …`, `running: …`, `web search: …`.
  Session-start hook events and other lifecycle noise are filtered out.
- **Permission modes** - `read` (default, read-only `--allowedTools`
  allowlist: Read/Grep/Glob/LS/WebSearch/WebFetch/TodoWrite), `none`
  (`--tools ""`, general knowledge only), and `full`
  (`--permission-mode bypassPermissions`, gated by `allowFullMode`). `plan`
  mode is deliberately avoided: it requires interactive plan approval and
  errors out headless (`error_during_execution`).
- **Friendly model aliases** - `sonnet` (default), `opus`, `haiku`,
  `fable`, plus exact passthrough (e.g. `claude-sonnet-5`).
- **Effort / thinking config** - `default` (omit `--effort`), `low`,
  `medium`, `high`, `xhigh`, mapped to `claude --effort`.
- **`/claude` slash command** - interactive picker (`SettingsList`) for the
  default model, default permission mode, default effort, and the
  `allowFullMode` toggle. If the project config shadows the global, the
  change is written there so it actually takes effect; otherwise it writes
  to global. Outside TUI (RPC/headless), prints a read-only status snapshot.
- **Config file** - `~/.pi/agent/ask-claude.json` (global) merged over
  `.pi/ask-claude.json` (project). Atomic writes (temp + rename).
- **Conflict guard against `pi-claude-bridge`** - self-disables (registers
  no tool, only an explainer `/claude` command) when the bridge is
  installed and enabled in `~/.pi/agent/settings.json` `packages` AND has
  `askClaude.enabled` truthy in `~/.pi/agent/claude-bridge.json` (merged
  with the project file). Detection replicates the bridge's own inputs and
  its truthy registration gate (`if (askConf?.enabled)`, verified against
  `pi-claude-bridge` `src/index.ts`). Fail-open: a broken `settings.json`
  never silently disables the standalone. The check also re-runs at
  `execute()` time, and a circular-delegation guard refuses to run when the
  active provider is already `claude-bridge`.
- **Process lifecycle** - spawned `claude` runs in a detached process group
  so its own tool subprocesses are killed on abort/timeout (not orphaned);
  a watchdog enforces the timeout cap with SIGTERM then SIGKILL after a
  grace period; stdout/stderr decoded at the stream level for UTF-8 safety
  across pipe chunks; the prompt is delivered via stdin so variadic flags
  (`--allowedTools` / `--tools`) cannot swallow a positional prompt; the
  `result.is_error` flag is captured and surfaced so a failed run is never
  reported as a clean answer; throttled status updates avoid O(n^2)
  re-renders.
- **Environment support** - `CLAUDE_BIN`, `CLAUDE_EXTRA_ARGS`.

### Security

- **Session-id validation** - the `sessionId` param is anchored to UUID
  shape (`/^[0-9a-fA-F]{8}-...-[0-9a-fA-F]{12}$/`). A leading-dash value
  (e.g. `--verbose`) can never bind to `--resume`, preventing argument
  injection when threaded after the resume positional. Non-matching values
  fall through to a fresh run.
- **`--verbose` is always set** - `claude -p --output-format stream-json`
  refuses to run without `--verbose`; the extension always includes it.
- **Prompt delivered via stdin** - `--allowedTools` / `--tools` are
  variadic and would swallow a positional prompt; sending the prompt via
  stdin removes that injection vector entirely.
- **`defaultModel` sanitized** - a config value starting with `-` (corrupted
  or hostile edit of `.pi/ask-claude.json`) falls back to the default
  rather than reaching argv, matching the per-call `model` leading-dash
  rejection.
- **Argument-injection surface minimized** - `model` values starting with `-`
  are rejected before reaching argv; `shell:false` throughout;
  `CLAUDE_EXTRA_ARGS` is parsed with a shell-like splitter (no backslash
  unescaping, documented).
