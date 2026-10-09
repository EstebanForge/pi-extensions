# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Initial release. Failure-loop detection (per command root, exploratory commands transparent, one-turn decay) consulting a peer reviewer through the shared one-shot consult core; guidance injected as a rigid `[SYSTEM NOTICE]` message at the next turn with staleness and cooldown gating. Publish boundary (`git push` / `gh pr create`) behind a confirm-and-consult step with decline-blocks semantics. `/unblock` manual consult. Project-scoped `.pi/unblock-settings.json` with defensive defaults; headless modes degrade to notify-only.
