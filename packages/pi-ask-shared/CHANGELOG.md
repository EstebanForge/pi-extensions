# Changelog

All notable changes to this project will be documented in this file.

## [0.1.3] - 2026-10-27

### Added

- `createStopHandler` accepts an optional `guard` callback, consulted before kill/settle. Returning a message vetoes the stop and leaves the run untouched; returning null proceeds as before. This covers the finishing window where the child already closed but discovery/classification is still running: a stop that settled the run failed there discarded a computed answer. Callers that pass no guard behave exactly as before.
