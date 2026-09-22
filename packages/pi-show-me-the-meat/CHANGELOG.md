# Changelog

## 1.0.1 — 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent`, `pi-ai`, `pi-tui` dev pins to `^0.84.0`. Audited against the pi v0.84.0 breaking changes (renamed `ModelsRequestTransforms`, null-tolerant `getApiKeyAndHeaders` headers, dropped `message_update` partial fields, v4 session APIs); no code changes were needed and `tsc`/`typecheck` passes against 0.84.0.

## 1.0.0 — 2026-08-04

First release.

A reading-diff tool for Pi. Give the `meat` tool a git diff and it returns only
the lines that carry the change: the meat, not the churn. An isolated sub-agent
reads the diff and submits a remove / replace / fold plan in original line
coordinates; a deterministic compiler projects that plan faithfully. The model
only picks *what to change*; it never authors output text.

### Added

- `meat` tool — reduces a git diff (any language) to its change-bearing lines.
  Five modes via `mode`: `working` (unstaged), `staged` (`--cached`), `all`
  (vs `HEAD`), `commit` (a SHA), and `range` (two refs, e.g. `main..HEAD`).
  `ref` is required for `commit` / `range`; a leading dash is rejected to defeat
  option injection. Output is the abridged reading diff plus a one-line summary
  and a manifest line.
- `path` parameter to narrow scope to a file or directory. The tool runs `git`
  **from** that path, so `path` can point into a nested repo.
- **REMOVE / REPLACE / FOLD** operation model. The sub-agent submits a plan in
  1-based original coordinates; the compiler keeps everything it does not name,
  drops removed ranges (with a `⋯⋯ N lines elided ⋯⋯` marker), collapses folded
  ranges into one machine-generated `marker + indent + "..."` row, and splices
  validated single-line elisions.
- **Mandatory import stripping** (`imports.ts`). A per-language, mechanical
  classifier removes import / module / include statements (Go blocks, Python
  `import` / `from (...)`, JS/TS `import` / `require`, Rust `use`, C/C++
  `#include`, Java `import`) before the model sees the diff. Imports vanish
  silently; they never earn an elision marker.
- **Diff layout analyzer** (`diff.ts`). Every physical line is classified
  (file header, ---/+++, hunk header, context, change, no-newline marker) and
  tagged with file id, hunk id, and source language. The compiler and the import
  classifier share this single parse.
- **Elision-projection validator.** A `replace`'s `new` must match all of `old`
  with every omitted span shown as `...` or `…`; the compiler builds the regex
  and rejects anything that adds, reorders, or retypes. `old` must also occur
  exactly once on the line.
- **Chunking.** A diff that exceeds a single sub-agent run (~2000 lines / 80 KB)
  is split at file, then hunk, boundaries, abridged chunk by chunk, and
  concatenated. Whole-diff hard cap ~4 MB. A single hunk that alone exceeds the
  budget is emitted whole (sub-hunk synthesis is future work).
- **Content-addressed cache.** `SHA-256(rubric + model id + diff)` keys the
  compiled reading diff on disk; a repeat run on the same diff returns instantly
  without spawning the sub-agent. Cache writes fail open.
- **First-parent merge rendering.** `commit` mode uses `git show -m
  --first-parent`, so merge commits render as a normal two-tree diff and flow
  through the compiler instead of being rejected.
- Isolated, in-memory sub-agent (`createAgentSession` +
  `SessionManager.inMemory`) does the abridging under a strict tool allowlist
  (`read`, `grep`, `submit` only). The full numbered diff and the abridging
  conversation stay in that ephemeral session; the main conversation receives
  only the small reading diff.
- Provider-agnostic by construction: the sub-agent reuses the parent's configured
  model, so it runs on Claude, GPT, Gemini, GLM, Ollama, anything Pi supports.
  Throws visibly if no model is configured.
- Abridgment rubric (`rubric.ts`) in its own words: default keep, drop residual
  noise, fold repetition, elide verbose single lines, preserve meaning (never
  invent), keep file / hunk headers for anything kept.
- Per-file manifest (`kept X/Y changed lines`, with `in A/B files` when more than
  one file) and TUI rendering that shows mode + ref + path on the call and the
  kept/total ratio, gap count, fold count, chunk count, and `cached` indicator on
  the result.

### Notes for integrators

- **The verbatim guarantee.** Every kept line in the output is a real line from
  the original diff, emitted verbatim and in order. FOLD rows and inline elisions
  are compiler-generated placeholders, clearly marked; a replacement can only
  delete characters, never add or reorder. The model authors no text. Imports are
  removed mechanically, not by the model.
- **Why remove-centric.** After imports are stripped mechanically, the remaining
  diff is mostly signal, so defaulting to KEEP and naming only the noise is the
  safer failure mode for a reading tool (showing a little extra beats omitting a
  real change).
- **Deliberately omitted** (documented, not silent): move detection and
  move-symmetry enforcement; sub-hunk synthesis for one giant hunk; the Python
  suite / delimiter / triple-quote validators; and the more exotic import cases
  (imports inside multiline strings, Python `try:`/`if:` guards, blank-row group
  framing). A fold may therefore collapse a Python suite header in a rare
  pathological case.

### Credits

The edit-plan model (REMOVE / REPLACE / FOLD), the elision-projection validator,
the import classifier, and the chunking strategy are inspired by
[meat](https://github.com/boldsoftware/meat) by
[boldsoftware](https://github.com/boldsoftware), licensed under Apache 2.0. This
package contains no meat code; the rubric is written in its own words and the
compiler is a minimal, independent TypeScript implementation.
