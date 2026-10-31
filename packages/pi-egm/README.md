# @estebanforge/pi-egm

The [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model) (EGM) on Pi: Google's open-source spec-driven development workflow, packaged as Pi skills with real `/egm-*` commands.

An **Elephant** (your Pi session, holding project context) drafts specifications. **Goldfish** reviewers — fresh subagents with zero conversation history — stress-test each draft against only the document and its referenced sources, exposing unstated assumptions and blind spots. You make the trade-offs and approve the design before any code is written.

Vendored verbatim from `google/elephant-goldfish-model` (Apache-2.0). The only content changes are one harness pointer per skill and the Pi tool name in the reviewer-dispatch enumerations. `PI.md` carries the Pi dispatch notes; `PI.md`-related concerns live there, not in the skill text.

## Skills

| Command | Skill | Use it to… |
| --- | --- | --- |
| `/egm-brainstorm` | egm-brainstorm | Test an idea with a Goldfish swarm and write `concepts_brief.md`. |
| `/egm-draft` | egm-draft | Turn a brief or notes into a design doc, section by section. |
| `/egm-review` | egm-review | Five-stage Goldfish review of a design doc (zoom-out, comprehension, critique, implementation readiness). |
| `/egm-resolve` | egm-resolve | Work through review findings and apply agreed edits. |
| `/egm-review-loop` | egm-review-loop | Run a configured reviewer group until convergence. |
| `/egm-bootstrap` | egm-bootstrap | Generate a README context hierarchy for an existing codebase. |
| `/egm-drift-report` | egm-drift-report | Compare checked-in designs with the current source for drift. |

Every skill also loads as a Pi skill (`/skill:egm-<name>`); the commands exist for parity with the upstream Antigravity and Claude Code UX. The full workflow and philosophy live in the [upstream docs](https://github.com/google/elephant-goldfish-model/tree/main/docs).

## Requirements

- Reviews (`/egm-brainstorm`, `/egm-review`, `/egm-review-loop`) need a fresh-context subagent tool in the session — [pi-subagent-manager](https://www.npmjs.com/package/pi-subagent-manager) provides `agent_spawn`. Without it, the skills stop and tell you, by design: a review in the same context is not a Goldfish review.
- Pi caps subagent nesting at depth 2, so `PI.md` routes reviewer dispatch directly from the Elephant instead of through the synthesizer. This is the fallback upstream sanctions for harnesses without nesting.

## Install

```bash
pi install npm:@estebanforge/pi-egm
```

Start a new session, then type `/egm-brainstorm Add webhook delivery to this project.` — the command prefills the editor with the skill prompt (press Enter to run, same as the fleet's command pattern). Continue with:

```text
/egm-draft
/egm-review docs/designs/webhooks.md
```

Commands need an interactive session; headless runs should read the vendored `skills/<name>/SKILL.md` directly.

Optional: add `EGM artifact directory: .dev/docs` to your `AGENTS.md` to keep briefs, drafts, and review reports out of the repo root.

## Provenance and license

- Skill, persona, and standards text: [google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model), Apache-2.0, Copyright Google LLC. Upstream is the canonical home for content changes.
- Pi integration (`PI.md`, `extensions/`, packaging): EstebanForge, Apache-2.0.
- Not an officially supported Google product.

## Develop

```bash
npm run check          # from the monorepo root: typecheck + tests
npx vitest run packages/pi-egm/tests   # this package's structure tests
pi -e ./packages/pi-egm                # try it without installing
```
