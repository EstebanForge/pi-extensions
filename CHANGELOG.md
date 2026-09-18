# Changelog

All notable changes to this project will be documented in this file.

## [1.0.5] - 2026-09-18

### Added

- **`thinking` param as a synonym for `reasoningEffort`.** The knob existed, but the word "thinking" appeared nowhere in the schema or docs, so a caller told "think harder / high thinking" had to translate to `reasoningEffort` unaided (and sometimes skipped it, silently running the configured default). `thinking` now accepts the same values and feeds the same `-c model_reasoning_effort`; both params with different values is a tool error, not a silent pick. Family alignment with AskAntigravity (`thinking`/`effort`) and AskClaude (`thinking`).

## [1.0.4] - 2026-09-10

### Changed

- **Default sandbox is now `danger-full-access` (was `workspace-write`).** Delegated Codex runs get unrestricted tool access with no approval prompts and no sandbox escalation failures (network or outside-workspace writes used to fail rather than ask under `workspace-write`), matching pi's own no-gate philosophy: pi's bash tool has neither sandbox nor gate. `workspace-write` (edit files in cwd only) and `read-only` (inspect without acting) remain per-call overrides or `defaultSandbox` in `~/.pi/agent/ask-codex.json`. The session-id UUID anchor and the model dash-guard are unchanged.

## [1.0.3] - 2026-08-13

### Added

- **Model, reasoning effort, and sandbox shown next to the tool name.**
  While a delegation runs, the TUI now renders
  `AskCodex [model=o4-mini, reasoning=high, sandbox=read-only]` with a
  prompt preview, plus a tidy result row (`✓ AskCodex 12.3s`) with an
  expandable body. Built on pi's `renderCall`/`renderResult` hooks; the
  values shown are the resolved config defaults, not just the args the
  caller passed. `CodexDetails` gained `reasoning` and `sandbox` fields.
- **Opt-in full-context delegation (`includeContext`).** New boolean param
  (default `false`, isolated one-shot unchanged). When `true`, the current pi
  conversation is exported as resolved markdown to
  `~/.pi/extensions-data/estebanforge/pi-ask-codex/` and the prompt tells
  Codex to read it first. The run passes `--add-dir` for that folder so the
  sandbox can read it; the temp file is removed after the run.

## [1.0.2] - 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent`, `pi-ai`, `pi-tui` dev pins to `^0.84.0`. Audited against the pi v0.84.0 breaking changes (renamed `ModelsRequestTransforms`, null-tolerant `getApiKeyAndHeaders` headers, dropped `message_update` partial fields, v4 session APIs); no code changes were needed and `tsc`/`typecheck` passes against 0.84.0.

## [1.0.1] - 2026-07-23

### Fixed

- **Model alias resolver uses runtime discovery, not hardcoded pins.**
  The hardcoded `MODEL_ALIASES` table (pinned to `gpt-5.4-mini` and
  `gpt-5.5`) is gone. The extension now shells out to
  `codex debug models --bundled` once at load, parses each slug into a
  family + version, and resolves aliases by picking the highest version
  of the named family. `full` and `gpt` now auto-track the current
  flagship (`gpt-5.6-sol` and whatever ships next) instead of going stale
  on every new release. Discovery failure is non-fatal: exact slugs the
  user types still pass through to codex verbatim.
- **Pinned syntax (`5.4 mini`, `5.6 main`) actually resolves.** Previously
  the family parser used exact-equality, so `"5.4 mini"` fell through to
  passthrough even though the tool description promised it worked. Family
  parsing now uses word-boundary regex (`\b(mini|nano)\b`, `\bcodex\b`,
  `\bpro\b`, `\b(full|gpt)\b`) with specific families checked before the
  generic `gpt` keyword so `gpt-...-mini` doesn't false-match the `gpt`
  family.
- **Flagship selection is deterministic.** Within the same version,
  entries now tiebreak by variant priority (`sol > plain > terra > luna`)
  instead of depending on the order `codex debug models --bundled`
  happened to return. Same priority applies to pinned-version resolution.
- **Leading-dash values passed as `model` are rejected before reaching
  argv.** A value like `--dangerously-bypass-approvals-and-sandbox` used
  to land verbatim as the `-m` token; the tool now refuses it with a
  clear error message, matching the `SESSION_ID_RE` threat model already
  applied to session ids.

### Changed

- Extension load runs `codexAvailable` and `discoverCodexModels` in
  parallel via `Promise.all`, cutting worst-case startup from 16s to 8s
  (each probe carries its own 8s watchdog).
- `resolveModel` returns `{ flagValue }` only; the unused `exact` field
  is gone (it was also mislabelled on passthrough branches).
- `classifySlug` no longer matches the `chat-latest` / `instant`
  suffixes — those don't appear in the `--bundled` catalog, so the branch
  was dead. A comment now notes that compound suffixes
  (`gpt-X.Y-mini-pro`-style) would also fall to `other` if OpenAI ever
  introduces them.
- Removed the unreferenced `STATUS_TAIL_CHARS` constant.

## [1.0.0] - 2026-07-07

Initial release.

### Added

- **`AskCodex` tool** — delegates a self-contained sub-task to OpenAI's
  [Codex CLI](https://github.com/openai/codex) via `codex exec --json`,
  streams structured progress events (command runs, file changes, reasoning)
  as partial output, and returns the final agent message. The tool answers
  to the names the CLI is known by — **codex**, **openai**, and **gpt** —
  surfaced in its description so the model maps any of them to this single
  tool.
- **Multi-turn conversations with Codex** — optional `sessionId` param.
  Omit for a one-shot (Codex starts fresh); pass the id returned in a prior
  call's result (`details.sessionId`, also shown in the result footer) to
  resume that session with full context. The agent decides per call which
  mode to use. Codex's JSON stream emits the session id directly in the
  `thread.started` event (no snapshot/diff hack), and `codex exec resume
  <id>` continues it natively. Codex holds all session state on disk; the
  extension is otherwise stateless.
- **Structured progress** — unlike plain stdout capture, the extension parses
  the `codex exec --json` JSONL stream and renders human-readable status:
  `running command: …`, `edited: path/to/file`, `searching: …`, reasoning
  breadcrumbs. Non-fatal transient `error` events (stream reconnects) are
  treated as progress, not failure.
- **Friendly model aliases** — `default` (omit the flag entirely), `mini`
  (gpt-5.4-mini), `full` (gpt-5.5), plus exact passthrough (e.g. `gpt-5.5`,
  `gpt-5.4-mini`). ChatGPT-account auth restricts available models, so the
  alias set is intentionally small and points only at known-good names.
- **Reasoning effort config** — `minimal`/`low`/`medium`/`high` passed to
  Codex via `-c model_reasoning_effort=…`. Defaults to `medium`. Lowering
  this is the primary lever for speed and token cost.
- **`/codex` slash command** — interactive picker (`SettingsList`) for the
  default model, default reasoning effort, and default sandbox mode. If the
  project config shadows the global, the change is written there so it
  actually takes effect; otherwise it writes to global. Outside TUI
  (RPC/headless), prints a read-only status snapshot.
- **Config file** — `~/.pi/agent/ask-codex.json` (global) merged over
  `.pi/ask-codex.json` (project). Atomic writes (temp + rename).
- **Defaults** — model `default` (Codex's own default), reasoning `medium`,
  sandbox `workspace-write` (Codex needs write access to be useful; pass
  `read-only` per-call to inspect without mutating).
- **Circular-delegation guard** — refuses to spawn Codex when the active Pi
  provider is already `codex`/`openai`.
- **Process lifecycle** — spawned `codex` runs in a detached process group so
  its own exec subprocesses are killed on abort/timeout (not orphaned); a
  watchdog enforces the timeout cap directly; stdout/stderr decoded at the
  stream level for UTF-8 safety across pipe chunks; stdin is closed so Codex
  never blocks waiting for terminal input; throttled status updates avoid
  O(n²) re-renders.
- **Environment support** — `CODEX_BIN`, `CODEX_EXTRA_ARGS`.

### Security

- **Session-id validation** — the `sessionId` param is anchored to UUID
  shape (`/^[0-9a-fA-F]{8}-...-[0-9a-fA-F]{12}$/`). This is stricter than a
  generic alphanumeric class: it makes a leading-dash value (e.g.
  `--dangerously-bypass-approvals-and-sandbox`, all letters and hyphens)
  impossible to pass, preventing argument injection that would silently
  disable codex's sandbox when threaded after the resume session-id
  positional. Non-matching values fall through to a fresh run.
- **Prompt end-of-options guard** — a literal `--` is inserted before the
  prompt positional, so a task beginning with a dash (e.g. `--help`, `-v`)
  is treated as the prompt, not a codex flag. Verified accepted by codex in
  both fresh and resume modes.
- **Timeout clamping** — `timeoutMinutes` is bounded to `[1, 1440]` minutes.
  Unclamped, a value of `0`, negative, `NaN`, or above ~35791m would overflow
  `setTimeout`'s 32-bit ceiling and fire the watchdog immediately, killing
  codex before it starts.
- **Argument injection surface minimized** — model, reasoning effort, and
  sandbox are enum/string-constrained before reaching the argv; `shell:false`
  throughout; `CODEX_EXTRA_ARGS` is parsed with a shell-like splitter (no
  backslash unescaping, documented).
