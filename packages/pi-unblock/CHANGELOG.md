# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Consult prompts tell the reviewer its wall-clock budget (seconds form at the default 45-second consult), so guidance arrives before termination instead of mid-diagnosis.
- Initial release. Failure-loop detection (per command root, exploratory commands transparent, one-turn decay) consulting a peer reviewer through the shared one-shot consult core; guidance injected as a rigid `[SYSTEM NOTICE]` message at the next turn with staleness and cooldown gating. Publish boundary (`git push` / `gh pr create`) behind a confirm-and-consult step: a declined command is blocked without running, and an approved command's review verdict blocks the call as its reason (the model reads the review before any push runs; re-issuing the identical command consumes a one-shot bypass). Triggers suppressed by cooldown, budget, or an in-flight consult reset the streak instead of wedging; consults honor the context abort signal; reviewer guidance is delivered mid-run (steer); headless sessions (no dialog UI) skip the gate with a log line. `/unblock` manual consult. Project-scoped `.pi/unblock-settings.json` with defensive defaults; headless modes degrade to notify-only.

### Fixed

- Publish and manual (`/unblock`) consults no longer spend the automatic budget or arm the failure-loop cooldown; those gates apply to automatic consults only.
- A failure streak that reaches its threshold while another consult is in flight resets instead of wedging past the threshold forever.
- The publish gate recognizes flagged, wrapped, absolute-path, and compound-segment forms (`git -C repo push`, `sudo git push`, `git status & git push`); quote-aware tokenization keeps lookalikes (`echo git push`) out.
- Consult failure notifications carry a sanitized stderr tail instead of raw reviewer output.
