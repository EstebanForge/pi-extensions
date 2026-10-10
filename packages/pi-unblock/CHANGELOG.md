# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Initial release. Failure-loop detection (per command root, exploratory commands transparent, one-turn decay) consulting a peer reviewer through the shared one-shot consult core; guidance injected as a rigid `[SYSTEM NOTICE]` message at the next turn with staleness and cooldown gating. Publish boundary (`git push` / `gh pr create`) behind a confirm-and-consult step: a declined command is blocked without running, and an approved command's review verdict blocks the call as its reason (the model reads the review before any push runs; re-issuing the identical command consumes a one-shot bypass). Triggers suppressed by cooldown or budget reset the streak instead of wedging; consults honor the context abort signal; headless sessions (no dialog UI) skip the gate with a log line. `/unblock` manual consult. Project-scoped `.pi/unblock-settings.json` with defensive defaults; headless modes degrade to notify-only.
