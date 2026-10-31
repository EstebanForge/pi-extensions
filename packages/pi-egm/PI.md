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

A Goldfish runs in a subagent with no conversation history.

- Spawn with the `agent_spawn` tool using a task path WITHOUT the `/root` prefix (for example `/goldfish-zoom-out`). `/root/...` paths fork this conversation and are not Goldfish reviews. If `agent_spawn` is not available in this session, stop and tell the user: a review in the same context is not a Goldfish review.
- The task text must be self-contained: first instruction = read the persona file (absolute path under the plugin root's `agents/`) and adopt it as the governing instructions; then the review prompt, the target document's absolute path, the standards' absolute paths, and any `GoldfishContext` reading list. Never pass this transcript, private reasoning, or answers the document is supposed to explain.
- Wait for actual completion (`agent_wait` on the spawned path). A launched reviewer is not a completed review. Propagate failures and timeouts.
- Fresh conversation context does not isolate the filesystem or memory services. Instruct every reviewer not to search agentmemory, session history, or any memory store to fill missing design context.
- Pi has no persona registry; reviewers read their persona from a file. This is the same dispatch pattern EGM upstream ships for Codex. Role to file map: `egm-design` → `agents/design_critic.md`, `egm-zoom-out` → `agents/zoom_out.md`, `egm-comprehension` → `agents/comprehension.md`, `egm-structural` → `agents/structural.md`, `egm-style` → `agents/style.md`, `egm-codebase-details` → `agents/codebase_details.md`, `egm-implementation-readiness` → `agents/implementation_readiness.md`, `egm-synthesizer` → `agents/synthesizer.md`.

## Nesting: use direct dispatch

Pi caps subagent nesting at two levels (this session plus one subagent level). A synthesizer subagent cannot itself spawn reviewers. Wherever a skill says the synthesizer spawns reviewers, dispatch each reviewer directly from this (Elephant) context with the same isolation, then synthesize the findings in-thread. This is the upstream-sanctioned fallback for harnesses without nesting.

## Structured question gates

The skills describe single-select gates. Use the structured question tool available in this session with strictly one question (Pi exposes `ask_user_question` when present) and no `(Recommended)` prefixes, exactly as the skills' interaction invariants require. Otherwise ask one plain-text question and end the turn. Tool unavailability is not approval.

## Invocation

Skills load as Pi skills (`/skill:egm-<name>`), and this package's extension registers one `/egm-<name>` command per skill, matching the upstream Antigravity and Claude Code UX. Both paths end at the same skill text.
