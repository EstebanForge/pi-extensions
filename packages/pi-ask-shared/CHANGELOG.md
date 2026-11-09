# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- **Windows: peers can actually run and actually die.** Spawning a bare peer name now probes `PATH` for the native executable (`name.com`/`name.exe`) and honors explicit `*_BIN` paths including extensionless ones; an npm `.cmd`/`.bat` shim is refused with a clear message (even when the shim is the only thing on `PATH`, and with the binary override named) instead of failing with `EINVAL`, because prompt text must never cross a command shell (codex passes its prompt as an argv positional). The kill switch no longer relies on POSIX process groups: Windows kills the tree via `taskkill /pid /T /F` (falling back to the direct child), so timeouts, aborts, and stop terminate the peer instead of orphaning it. New exports `resolveSpawnTarget` and `createKillTree` back both behaviors.

## [0.1.3] - 2026-10-27

### Added

- `createStopHandler` accepts an optional `guard` callback, consulted before kill/settle. Returning a message vetoes the stop and leaves the run untouched; returning null proceeds as before. This covers the finishing window where the child already closed but discovery/classification is still running: a stop that settled the run failed there discarded a computed answer. Callers that pass no guard behave exactly as before.
