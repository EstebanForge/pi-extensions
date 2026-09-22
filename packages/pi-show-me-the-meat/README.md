# @estebanforge/pi-show-me-the-meat

A **reading-diff** tool for Pi. Give it a git diff and it returns only the lines that carry the change: the meat, not the churn. Inspired by [meat](https://github.com/boldsoftware/meat).

## How it works

1. The `meat` tool reads a git diff (any language), strips the diffstat, and **removes import / module / include statements mechanically** (Go, Python, JS/TS, Rust, C/C++, Java) before the model ever sees it.
2. It spawns an **isolated sub-agent** (a fresh, in-memory agent session) that reads the numbered diff and calls a `submit` tool with a **remove / replace / fold** edit plan.
3. A **deterministic compiler** projects that plan faithfully. Every line the model does not name is emitted verbatim.

The model only picks *what to change*. It never authors output text:

- **KEEP** (implicit) — every line not named is emitted as-is.
- **REMOVE** — drop a range entirely (shown as a `⋯⋯ N lines elided ⋯⋯` marker).
- **FOLD** — collapse ≥2 same-polarity lines into one machine-generated `marker + indent + "..."` row (repetitive suites, test tables, enum arms).
- **REPLACE** — elide within a single line (error/log/format strings). The compiler validates `new` is a **deletion-only projection** of `old` (each gap marked `...` or `…`), so nothing can be invented.

## The guarantee

Every **kept** line in the output is a real line from the original diff, emitted verbatim and in order. A **fold row** and an **inline elision** are compiler-generated placeholders — clearly marked (`+    ...`, or `...` inside a line) — and a replacement can only *delete* characters, never add or reorder. The model authors no text. Imports are removed mechanically, not by the model.

## Why it is built this way

- **Clean context.** The full diff and the whole abridging conversation live in the sub-agent's ephemeral session, which is disposed when done. The main conversation only receives the small reading diff.
- **Any provider.** The sub-agent reuses your configured Pi model, so it runs on Claude, GPT, Gemini, GLM, Ollama, anything. No second process, no second API key, no lock-in.
- **Faithful output.** A minimal compiler (the meat principle distilled to KEEP / REMOVE / FOLD / REPLACE) guarantees the reading diff is a projection of the real diff. No invention, no paraphrase.
- **Large diffs.** Diffs that exceed a single sub-agent run are split at file, then hunk, boundaries, abridged chunk by chunk, and concatenated. Re-running `meat` on the same diff hits a content-addressed cache and returns instantly.

What this extension deliberately **omits** from meat: move detection (and move-symmetry enforcement), sub-hunk synthesis for one giant hunk, and the more exotic import cases (imports embedded inside multiline strings, Python `try:`/`if:` import-guard suites, blank-row group framing). These are documented gaps, not silent failures.

## Install

```
pi install npm:@estebanforge/pi-show-me-the-meat
```

## Usage

Ask Pi: **"give me the meat of my staged changes"**, or **"abridge this diff"**, or **"just the important parts of commit abc123"**.

The tool runs `git` in one of five modes:

| Mode | Description | Needs `ref` |
| --- | --- | --- |
| `working` | Unstaged changes | No |
| `staged` | Staged (cached) changes | No |
| `all` | All changes vs HEAD | No |
| `commit` | A specific commit (merges render as a first-parent diff) | Yes (SHA) |
| `range` | A commit range | Yes (e.g. `main..HEAD`) |

Narrow scope with `path` (a file or directory). The tool runs `git` **from** that path, so `path` can point into a nested repo.

## Example

For a diff that shuffles imports, adds a retry branch, and repeats three struct-literal assignments, meat returns:

```
diff --git a/uploader.go b/uploader.go
--- a/uploader.go
+++ b/uploader.go
@@ -20,6 +24,11 @@ func (u *Uploader) Put(ctx context.Context, r io.Reader) error {
 		return fmt.Errorf("put: %w", err)
+		var terr *TransientError
+		if errors.As(err, &terr) {
+			return u.retry(ctx, r)
+		}
@@ -40,3 +49,7 @@ var defaults = Config{
+		Timeout:   5 * time.Second,
+		...
+		Retries:   3,
```

with summary `retry Put on transient errors using exponential backoff` and manifest `kept 9/24 changed lines`. The import shuffle is gone (removed mechanically); the repeated config assignments folded into one `+		...` row.

## Limits

- **Single huge hunk.** A diff is split at file then hunk boundaries. A single hunk that alone exceeds the per-run budget (~2000 lines / 80 KB) is emitted whole rather than synthesized into sub-hunks. Narrow it with `path` or a smaller range.
- **One model pass per chunk.** Each chunk is an independent sub-agent run (there is no cross-chunk merge pass), the same strategy meat uses.
- **Merge diffs.** A merge commit is rendered as a first-parent diff (`git show -m --first-parent`), which the compiler handles. True combined diffs (`diff --cc` / `@@@`) are still rejected.
- **Hostile input.** The tool exists to read changes authored by others, and `remove` is a legitimate operation, so a crafted diff can instruct the abridger to hide its own payload. "Verbatim" means every kept line is faithful; it does not mean the result is complete or tamper-evident. Treat untrusted diffs accordingly.

## TUI rendering

The call shows mode, ref, and path. The result shows the kept/total ratio, gap count, fold count, and a `cached` indicator at a glance.

## Credits

The edit-plan model (REMOVE / REPLACE / FOLD), the elision-projection validator, the mandatory import classifier, and the chunking strategy are inspired by [meat](https://github.com/boldsoftware/meat) by [boldsoftware](https://github.com/boldsoftware), licensed under Apache 2.0. This package contains no meat code; the rubric is written in its own words and the compiler is a minimal, independent TypeScript implementation of the core idea.

## License

MIT
