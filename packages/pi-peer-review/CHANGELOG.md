# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- The `/unblock settings` dialog now renders on the shared `@estebanforge/pi-tui-dialogs` framed dialog kit: bordered `label │ value` rows, a help panel for the selected setting, type-to-search, and inline validated input editors, replacing the bare SettingsList overlay. Behavior unchanged: cycle rows still flip in place, text rows still open a validated editor, and every change still saves when the dialog closes.

## [1.0.0] - 2026-10-11

First release under this name (the failure-loop gate shipped earlier as a 0.1.x draft; this is the same extension, broadened and renamed).

### Added

- `/peer-review`: adversarial peer review of every change since the last check. Diff material under git (content-addressed tree snapshots through a throwaway index; untracked files included, the real index untouched), an mtime-walk audit without git. The frame carries the user's prompts, the executor's final claim, the diff stat, prioritized hunks (20 KB / 40 files, remainder named with a coverage demand), and post-work verification facts. Findings are severity-tagged (`BLOCKER`/`RISK`/`NIT`, max 5, `NO_BLOCKERS` escape, `file:line` evidence or `UNVERIFIED:`), shown in full, and BLOCKER/RISK findings are injected into the model's next prompt as untrusted claims. Second pass over the same work runs verification mode: close the previous findings, hunt regressions, no new NITs.
- Reviewer selection per call and per peer: `/peer-review claude|codex|agy` overrides the reviewer for one call; new `effort` plus per-reviewer `claudeModel`/`claudeEffort`/`codexModel`/`codexEffort`/`agyModel`/`agyEffort` settings set model and thinking effort globally or per reviewer (per-reviewer keys win).
- Works outside git repositories: audit mode with no before-state, honest framing, and `UNATTRIBUTABLE` tags for findings that may predate the executor's edits (shown, never auto-sent).
- Secret guard: secret-path material (env files, key material, credential stores) is withheld by name; all inlined content passes a redaction pass.
- Publish boundary upgrade: the confirm dialog shows "N files changed since last peer review", the pre-publish consult uses the peer-review frame when unreviewed work exists, and a successful publish review advances the pointer.
- Passive local telemetry (`.pi/unblock-log.jsonl`): settled runs and review outcomes, no consults.

### Changed

- Command surface: `/peer-review` is the main command; `/unblock` and `/advice` are aliases for the stuck consult (ring-based frame, unchanged behavior). `settings` works from every door; `stuck [focus]` / `review [focus]` force a door explicitly.
- Settings editor covers all 20 knobs, including the new model/effort keys, with the same clamp enforcement as the loader.
- Review consults run with `max(120s, 3 x timeoutSec)` so file-reading reviews cannot livelock against the short consult timeout.
