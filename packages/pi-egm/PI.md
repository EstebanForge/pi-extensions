<!--
Copyright 2026 Google LLC.
SPDX-License-Identifier: Apache-2.0

Pi adaptation notes authored for the @estebanforge/pi-egm package; skill and
persona text remains Google's Elephant-Goldfish Model (Apache-2.0).
-->

# Pi integration (Elephant-Goldfish Model on Pi)

Read this first when running EGM on Pi. It maps the harness-agnostic wording in the skills to Pi's tools. Nothing here changes the skills' rules; it only names Pi's equivalents.

## Paths and artifacts

- The plugin root is two directories above any skill's `SKILL.md`. Resolve `agents/`, `resources/`, and this file against that root. Resolve user documents and generated artifacts against the working directory. Never substitute similarly named files from the user's project for bundled personas or standards.
- If the user's prompt or `AGENTS.md` has a line `EGM artifact directory: <path>`, write briefs, drafts, and reports there. A relative path resolves against the working directory; create the folder if it does not exist.

## Fresh-context Goldfish reviewers (CRITICAL)

A Goldfish runs in a child session with no conversation history. On Pi this is the `egm_goldfish` tool: it starts a fresh headless process with no extensions, no context files, and no persisted session, so freshness holds by construction — the child has no memory tools, no injected context, and no other spawn tools to misuse. Never substitute a generic subagent tool: a forked-context spawn is not a Goldfish review, and during EGM flows this package blocks spawn-shaped tools other than `egm_goldfish`.

- Dispatch one `egm_goldfish` call per reviewer. Parameters: `role` (the persona, resolved to a bundled file in code — `egm-design` → `design_critic.md`, `egm-zoom-out` → `zoom_out.md`, `egm-comprehension` → `comprehension.md`, `egm-structural` → `structural.md`, `egm-style` → `style.md`, `egm-codebase-details` → `codebase_details.md`, `egm-implementation-readiness` → `implementation_readiness.md`, `egm-synthesizer` → `synthesizer.md`, `egm-bootstrap-orchestrator` → `bootstrap_orchestrator.md`), `target`, `report_path`, optional `standards`, `goldfishContext`, `focus`, `timeout_minutes` (default 15).
- The tool builds the self-contained task text itself: persona first, standards and baseline reading, target document, and the artifact-first instruction to write the full report to `report_path` before replying. Never pass this transcript, private reasoning, or answers the document is supposed to explain.
- The tool waits for actual completion and hard-fails on timeout, nonzero exit, or a missing/empty report; it returns the report path plus a two-line summary. A launched reviewer is not a completed review — propagate failures.
- Reviews are capped at three concurrent child sessions; extra dispatches queue.

## Nesting: use direct dispatch

Wherever a skill says the synthesizer spawns reviewers, dispatch each reviewer directly from this (Elephant) context with the same isolation, then synthesize the findings in-thread. This is the upstream-sanctioned fallback for harnesses without nesting; on Pi it is also structural, because a Goldfish child runs without extension tools and cannot spawn anything itself.

## Structured question gates

The skills describe single-select gates. Use the structured question tool available in this session with strictly one question (Pi exposes `ask_user_question` when present) and no `(Recommended)` prefixes, exactly as the skills' interaction invariants require. Otherwise ask one plain-text question and end the turn. Tool unavailability is not approval.

## Invocation

Skills load as Pi skills (`/skill:egm-<name>`), and this package's extension registers one `/egm-<name>` command per skill, matching the upstream Antigravity and Claude Code UX. Both paths end at the same skill text.
