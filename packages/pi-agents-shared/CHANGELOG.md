# Changelog

## [0.1.1] - 2026-10-31

### Added

- `runProcess` child-process lifecycle, vendored from `@estebanforge/pi-ask-shared` 0.1.3 so pi-ask-shared stays frozen: detached spawn with process-group SIGTERM/SIGKILL, abort and hard-timeout enforcement, close-settled output in line and raw modes, stdin transport with EPIPE tolerance, stderr and line-buffer caps, `RunSpawnError` for spawn-level failures.

### Changed

- `RunProcessOutcome.exitCode` is now `number | null` with a new `signal` field: a child killed by an external signal (OOM supervisor, manual kill) reports `exitCode: null` plus the signal name instead of masking as exit 0. Callers that accept only completed work must hard-fail on `signal`.
