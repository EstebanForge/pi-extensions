# Changelog

All notable changes to this project will be documented in this file.

## [0.1.6] - 2026-11-13

### Changed

- **The Antigravity model resolver now resolves a single-base catalog tiered slug before the bare-"gemini" Flash fallthrough.** A bare base slug the live catalog advertises (`gemini-4-hydrogen`, next `claude-sonnet-5-5`) picks its tier variant from the configured default thinking or the explicit tier, instead of silently resolving as the Flash family — the fallthrough matched any string containing "gemini". A version pin spanning multiple bases (`gemini-3.6` over Flash and Pro lines) is NOT a tiered base: it keeps the Flash family semantics instead of picking a base by catalog order. Bare `gemini` stays the Flash alias, and unknown bases keep the raw passthrough. Consumers (pi-antigravity-bridge, pi-ask-antigravity) ship a `gemini-4-hydrogen` default on top of this: publish shared first, then the consumers bump their shared floor.

## [0.1.5] - 2026-11-10

### Added
- **Background runs now track the child-closed window as explicit registry state.** `BackgroundRun.status` gains `finishing` and `markFinishing()` latches the running-to-finishing transition at child close; `settle()` accepts settling from it. The concurrency cap frees the slot once the child closed (finishing runs hold no process), and the TTL sweep never drops a finishing run because its answer still owes a wake.

## [0.1.4] - 2026-11-09

### Added
- `UNTRUSTED_BANNER` is now exported, so consumers wrap peer-run output (wake bodies, task-log tails) in the exact banner string instead of copying it and letting the texts drift.

### Fixed
- **Windows: peers can actually run and actually die.** Spawning a bare peer name now probes `PATH` for the native executable (`name.com`/`name.exe`) and honors explicit `*_BIN` paths including extensionless ones; an npm `.cmd`/`.bat` shim is refused with a clear message (even when the shim is the only thing on `PATH`, and with the binary override named) instead of failing with `EINVAL`, because prompt text must never cross a command shell (codex passes its prompt as an argv positional). The kill switch no longer relies on POSIX process groups: Windows kills the tree via `taskkill /pid /T /F` (falling back to the direct child), so timeouts, aborts, and stop terminate the peer instead of orphaning it. New exports `resolveSpawnTarget` and `createKillTree` back both behaviors.

## [0.1.3] - 2026-10-27

### Added

- `createStopHandler` accepts an optional `guard` callback, consulted before kill/settle. Returning a message vetoes the stop and leaves the run untouched; returning null proceeds as before. This covers the finishing window where the child already closed but discovery/classification is still running: a stop that settled the run failed there discarded a computed answer. Callers that pass no guard behave exactly as before.
