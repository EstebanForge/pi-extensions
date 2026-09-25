# Changelog

All notable changes to this project will be documented in this file.

## [1.2.8] - 2026-09-25

### Fixed

- **Exit 0 with no output is a failure, not a silent success.** Same bug as the bridge fix: a headless `agy -p` run auto-denies a permission-gated tool call (the command gate in plan mode bites hardest since plan runs never receive the skip flag), prints the reason only to stderr, exits 0, and the execute path fell through to success, returning just the conversation footer. An empty answer now returns a loud failure note carrying the stderr plus the remedy (allow-list the command under `permissions.allow`, or rerun outside plan mode), and a new `details.empty` marker flips the TUI result row to its error glyph instead of a green checkmark. Three new tests pin both stderr shapes and the glyph flip through the fake-binary stub; HOME is pointed at an empty tmpdir during them so the bridge-deferral scan finds nothing and the factory registers.

## [1.2.7] - 2026-09-25

### Fixed

- **Plan mode never receives `--dangerously-skip-permissions`.** agy's plan-mode no-write gate IS a permission request ("File creation requires plan approval"), and the skip flag auto-approves every permission request — so a `mode: "plan"` delegation could edit the workspace inside the `--add-dir` grant despite the review-only contract. The default `skipPermissions` knob made this the out-of-the-box behavior. Probe evidence transfers directly (same binary, same `-p` path): with the flag a plan run wrote files; without it, file-write and run_command attempts end exit 0 in ~20-30 s with a "confirm plan" message — fail-visible, never the upstream #318 prompt-hang. Plan runs now never receive the flag, and the tool description and README state the enforcement instead of the aspirational claim.

Version 1.2.6 was a fleet-wide version stamp with no package changes.

## [1.2.5] - 2026-09-18

### Added

- **`thinking` / `effort` params on AskAntigravity (synonyms).** Port of the pi-antigravity-bridge fix: delegation calls had no direct tier knob (only tier sugar inside `model`, "flash high"), so a caller told "peer review on high thinking" fell through to the configured default with no signal anything was dropped. `thinking` takes pi vocabulary (minimal|low|medium|high|xhigh|max, clamped to agy's low|medium|high; unknown values fall back to low) and `effort` is the same knob under agy's own name. Explicit level beats a tier embedded in `model` and the config default; different values on both errors; fixed-thinking families ignore it because agy rejects `--effort` for them.

## [1.2.4] - 2026-08-13

### Added

- **Model, thinking tier, and mode shown next to the tool name.** While a
  delegation runs, the TUI now renders
  `AskAntigravity [model=gemini-3.6-flash, thinking=high]` with a prompt
  preview, plus a tidy result row (`✓ AskAntigravity 12.3s`) with an
  expandable body. Built on pi's `renderCall`/`renderResult` hooks; the
  values shown are the resolved config defaults (model alias + tier), not
  just the args the caller passed. `AgyDetails` gained a `thinking` field.
- **Opt-in full-context delegation (`includeContext`).** New boolean param
  (default `false`, isolated one-shot unchanged). When `true`, the current pi
  conversation is exported as resolved markdown to
  `~/.pi/extensions-data/estebanforge/pi-ask-antigravity/` and the prompt
  tells agy to read it first. The run passes `--add-dir` for that folder so
  the sandbox can read it; the temp file is removed after the run.

## [1.2.3] - 2026-08-10

### Fixed

- **Model parsing now handles agy's real two-column output.** `agy models`
  prints `<slug>  <display label>` per line, and `--model` accepts only the
  slug. `parseModelLine` swallowed the whole line and the static
  `sonnet`/`opus`/`gpt-oss` overlay used display labels, so `--model` was
  rejected. It now splits column 1; the overlay uses real slugs
  (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`);
  and `resolveModel` returns a `{model, effort?}` shape that sends
  Gemini-family bases' tier to `--effort` while fixed-thinking families keep
  the exact slug with no `--effort` (agy rejects it for them).
  `parseModelLine`/`mergeCatalog`/`resolveModel` are now exported, with
  two-column parser tests on the verified live `agy models` fixture.

## [1.2.1] - 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent`, `pi-ai`, `pi-tui` dev pins to `^0.84.0`. Audited against the pi v0.84.0 breaking changes (renamed `ModelsRequestTransforms`, null-tolerant `getApiKeyAndHeaders` headers, dropped `message_update` partial fields, v4 session APIs); no code changes were needed and `tsc`/`typecheck` passes against 0.84.0.

## [1.2.0] - 2026-07-26

### Added

- **`permissions` config + `/agy` row + `AGY_SKIP_PERMISSIONS` env.** Controls
  the new flag. Default `auto-approved` (required for non-interactive use); set
  to `prompt` (`/agy` picker, or `AGY_SKIP_PERMISSIONS=0`) to disable - but
  then any `run_command` hangs until you kill the call. Matches the bridge's
  permissions knob.

### Changed

- **Defers to `pi-antigravity-bridge` when it is installed.** The bridge now
  ships both the streaming antigravity provider AND the `AskAntigravity` tool
  (same shape as `pi-claude-bridge`). To avoid a duplicate-tool clash, this
  extension detects the bridge at load and, if present, registers nothing -
  silently. Detection does not use module resolution (pi isolates each
  package's module root); it checks an in-process `Symbol.for` flag the bridge
  sets AND the bridge's package.json at pi's install paths
  (`@estebanforge/pi-antigravity-bridge/package.json`). Order-independent for
  npm/git installs; for local/source installs relies on the in-process flag
  (install the bridge first so it loads first). Without the bridge, behavior is
  unchanged.

### Fixed

- **`run_command` no longer hangs the tool.** `--mode accept-edits` auto-approves
  file edits but NOT shell commands, so any task that triggered a `run_command`
  hung forever on an unanswerable `y/n` prompt in non-interactive `-p` mode
  (same root cause the pi-antigravity-bridge provider hit). The tool now passes
  `--dangerously-skip-permissions` by default. Backported from the bridge.

## [1.1.0] - 2026-07-25

### Fixed

- **`CONV_ID_RE` rejected real agy conversation ids, silently breaking the
  "continued conversation" feature.** The regex was
  `/^[A-Za-z0-9]{1,128}$/` (no hyphens in the character class), but agy
  conversation ids are hyphenated UUIDs (e.g.
  `9e6fdc2f-f9f9-4096-95fc-7852528b50cc`, the very example in the source
  comment). Every legitimate id failed validation, so `isContinuation`
  was always `false`, `--conversation <id>` was never passed, and every
  "continued" call quietly started a brand-new agy conversation instead
  of resuming. Now allows hyphens in the body
  (`/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/`) while preserving the threat
  model: first char must be alphanumeric, so leading-dash flag-injection
  values are still rejected. Present since 1.0.0; found by peer review.

### Added

- **`mode` parameter** — replaces the previous `skipPermissions` boolean
  with an explicit two-way enum: `plan` (review-only, `--mode plan`) and
  `accept-edits` (agy applies edits, `--mode accept-edits`, default).
  Use `plan` for cross-review and read-only tasks, `accept-edits` for
  implementation.
- **`digest` parameter** — when true, the prompt is prefixed with
  `(Use compact digests, not full file contents.)` to keep `agy` from
  returning full file payloads. Default: `true` for `plan`,
  `false` for `accept-edits`. Override per call.
- **Non-Gemini alias overlay** — `sonnet`, `opus`, and `gpt-oss` now
  resolve to the exact agy strings `Claude Sonnet 4.6 (Thinking)`,
  `Claude Opus 4.6 (Thinking)`, and `GPT-OSS 120B (Medium)`. A
  static short-alias map is checked before the family parser, so
  these names resolve even when `agy models` does not surface them
  in the live catalog (older agy builds, plan-gated models). The
  overlay entries are also merged with the live catalog at
  extension load; live entries always win on case-insensitive
  full-string equality, so an updated `agy models` listing takes
  precedence over the hardcoded fallback. Borrowed from
  `@bacnh85/pi-agy`'s static model map.
- **Effective `mode` and `digest` surfaced in `details`** — every
  tool result now reports the resolved mode and whether the digest
  prefix was applied, so the orchestrating model (and humans reading
  logs) can see what flags were actually passed to `agy`.
- **Case-insensitive live-catalog lookup for overlay aliases.** When
  `sonnet` / `opus` / `gpt-oss` resolve via the overlay, the lookup
  against the live catalog is now case-insensitive so the
  "live entries win" guarantee holds even if `agy models` lists the
  same model under different casing than the hardcoded overlay.
  Matches `mergeCatalog`'s dedup logic.

### Changed

- **Breaking: `skipPermissions` parameter is removed.** Use `mode`
  instead. The previous `skipPermissions: true` (which passed
  `--dangerously-skip-permissions`) was a coarse proxy for the new
  `mode: "accept-edits"` and is no longer the right primitive. Use
  `mode: "plan"` for review-only flows. No callers in the wild
  depend on the old boolean (the package shipped 2026-07-07), so
  the break is contained to a single minor bump.
- **No `sandbox` enum value.** A peer review caught that agy's
  `--sandbox` flag is an orthogonal shell-containment setting,
  not an "edit preview" mode. Users who need shell containment
  should set `AGY_EXTRA_ARGS=--sandbox` in their environment.
- **Tool description** now documents the `mode` and `digest`
  affordances so the orchestrating model knows about them.

## [1.0.1] - 2026-07-23

### Fixed

- **`gemini-flash-latest` and `gemini-pro-latest` aliases now win over
  versioned entries when no version is pinned.** Previously, asking for
  `flash` resolved to the highest version of the flash family (e.g.
  `Gemini 3.6 Flash (Medium)`), which is a concrete snapshot — not
  Google's "latest release" pointer. The resolver now prefers entries
  with `version: null` (the aliases that `parseModelLine` produces from
  names like `Gemini Flash Latest`) over versioned entries. Falls back
  to the highest version if no alias is present in the catalog, so
  older agy builds without `*-latest` entries keep working.
- **Leading-dash values passed as `model` are rejected before reaching
  argv.** A value like `--dangerously-skip-permissions` used to land
  verbatim as the `--model` token; the tool now refuses it with a clear
  error message, matching the `CONV_ID_RE` threat model already applied
  to conversation ids.

### Changed

- `modelParam` is now a plain `Type.String()` instead of a conditional
  `StringEnum` built from the live catalog. The enum was too restrictive
  when discovery succeeded (the common case): any tiered or pinned
  alias like `"flash high"` or `"3.5 flash"` failed AJV validation
  before `resolveModel` ever saw it. Plain `Type.String()` lets the
  resolver handle every documented form and falls back to agy for
  unknown slugs. The now-unused `StringEnum` import is gone.

## [1.0.0] - 2026-07-07

Initial release.

### Added

- **`AskAntigravity` tool** — delegates a self-contained sub-task to Google
  Antigravity's `agy` CLI (the CLI for Gemini) via `agy -p`, streams stdout
  as partial output, and returns the final response. The tool answers to
  three names the CLI is known by — **gemini**, **antigravity**, and **agy**
  — surfaced in its description so the model maps any of them to this single
  tool.
- **Multi-turn conversations with agy** — optional `conversationId` param.
  Omit for a one-shot (agy starts fresh); pass the id returned in a prior
  call's result (`details.conversationId`) to resume that conversation with
  full context. The agent decides per call which mode to use. On fresh runs
  the extension discovers the new conversation id agy creates (snapshot +
  diff of agy's conversations dir, the one technique borrowed from
  [`antigravity-acp`](https://github.com/shubzkothekar/antigravity-acp)'s
  `scan.ts`); on continued runs it passes `--conversation <id>` which agy
  resumes natively. agy holds all state in its own SQLite DB; the extension
  is otherwise stateless.
- **Friendly model aliases** — `flash`, `pro`, `gemini`, plus tier/version
  qualifiers (`flash high`, `3.1 pro`). Aliases resolve to the exact
  `agy models` string using numeric version comparison, with nearest-tier
  fallback (Pro has no Medium → falls back to High; ties break toward the
  higher tier so "latest and greatest" wins).
- **`/agy` slash command** — interactive picker (`SettingsList`) for the
  default model and default thinking tier. If the project config shadows the
  global, the change is written there so it actually takes effect; otherwise
  it writes to global. Outside TUI (RPC/headless), prints a read-only status
  snapshot.
- **Config file** — `~/.pi/agent/ask-antigravity.json` (global) merged over
  `.pi/ask-antigravity.json` (project). Atomic writes (temp + rename).
- **Defaults** — model `flash`, thinking `medium` (Gemini 3.5 Flash Medium).
- **Circular-delegation guard** — refuses to spawn agy when the active Pi
  provider is already `antigravity`/`agy`.
- **Process lifecycle** — spawned `agy` runs in a detached process group so
  its own exec subprocesses are killed on abort/timeout (not orphaned); a
  watchdog enforces the timeout cap directly (not just via agy's
  `--print-timeout`); stdout/stderr decoded at the stream level for UTF-8
  safety across pipe chunks; throttled status updates avoid O(n²) re-renders.
- **Environment support** — `AGY_BIN`, `AGY_EXTRA_ARGS`,
  `AGY_CONVERSATIONS_DIR`.
