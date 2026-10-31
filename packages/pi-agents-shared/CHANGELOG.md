# Changelog

## [Unreleased]

### Added

- `runProcess` child-process lifecycle, vendored from `@estebanforge/pi-ask-shared` 0.1.3 so pi-ask-shared stays frozen: detached spawn with process-group SIGTERM/SIGKILL, abort and hard-timeout enforcement, close-settled output in line and raw modes, stdin transport with EPIPE tolerance, stderr and line-buffer caps, `RunSpawnError` for spawn-level failures.
