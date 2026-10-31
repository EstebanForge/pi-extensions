# Changelog

## [Unreleased]

### Added

- Initial package: all seven EGM skills (brainstorm, draft, review, review-loop, resolve, bootstrap, drift-report), nine Goldfish reviewer personas, five document standards, and execution instructions vendored verbatim from google/elephant-goldfish-model v0.1.0 (Apache-2.0).
- Per-skill Pi pointer to `PI.md`, which maps Goldfish dispatch to `agent_spawn` fresh-path spawns, mandates direct dispatch instead of synthesizer nesting (Pi depth cap), and carries the artifact-directory and question-gate conventions.
- `extensions/index.ts` registering one `/egm-<skill>` command per skill, derived from the vendored frontmatter. Commands prefill the editor (fleet pattern; handlers cannot start runs), matching the upstream Antigravity/Claude Code slash UX.
- Structure tests: skill/persona/standards parity with upstream, frontmatter validity, referential integrity of `agents/` and `resources/` references, license markers, Pi pointers.
