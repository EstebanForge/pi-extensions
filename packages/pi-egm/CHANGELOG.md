# Changelog

## [Unreleased]

### Added

- Initial package: all seven EGM skills (brainstorm, draft, review, review-loop, resolve, bootstrap, drift-report), nine Goldfish reviewer personas, five document standards, and execution instructions vendored verbatim from google/elephant-goldfish-model v0.1.0 (Apache-2.0).
- Per-skill Pi pointer to `PI.md`, which maps Goldfish dispatch to the bundled `egm_goldfish` tool, mandates direct dispatch instead of synthesizer nesting, and carries the artifact-directory and question-gate conventions.
- `extensions/goldfish.ts` registering `egm_goldfish`: each reviewer runs in a fresh headless child process (`--no-extensions --no-context-files --no-session --no-mcp`), so the zero-context guarantee holds without any subagent extension. Hard-fails on timeout, nonzero exit, or missing/empty reports; caps three concurrent child sessions; kills strays on session shutdown.
- A `tool_call` guard that arms during EGM flows (an `/egm-*` command, a `/skill:egm-*` invocation, or an `egm_goldfish` call) and disarms on the next non-EGM user input, blocking spawn-shaped tools other than `egm_goldfish` so a partially compatible subagent extension cannot silently fork context into a reviewer (name-based denylist; residual risk documented in the README).
- `extensions/index.ts` registering one `/egm-<skill>` command per skill, derived from the vendored frontmatter. Commands prefill the editor (fleet pattern; handlers cannot start runs), matching the upstream Antigravity/Claude Code slash UX.
- Skill-line divergence from upstream, sanctioned and recorded: the four reviewer-dispatch paragraphs name `egm_goldfish` where other harnesses name their own spawn tool.
- Structure tests: skill/persona/standards parity with upstream, frontmatter validity, referential integrity of `agents/` and `resources/` references, license markers, Pi pointers, plus `egm_goldfish` unit tests (isolation flags, timeout/empty-report hard failures, abort propagation, concurrency cap).
- Dependency: `@estebanforge/pi-ask-shared ^0.1.3` for the child-process lifecycle (`runProcess`: detached process-group kill, abort, timeout, close-settled output).
