# Changelog

## 1.3.1 — 2026-09-10

### Fixed
- **Parallel gated tool calls no longer hang.** pi's TUI shows ONE extension dialog at a time; an overlapping `ctx.ui.confirm`/`ctx.ui.editor` call replaces the live dialog and the replaced promise never settles, so a batch like three `git_commit` calls showed one gate and left the other tool calls waiting forever (cancel + resume was the only exit). `confirmWrite` now holds a process-wide FIFO lock (`withDialogLock`) only while a dialog is open: the first prompt renders, the rest appear in turn as each is answered, and a throwing dialog cannot wedge the queue (released in `finally`).
- The lock is shared across ALL pi-* extensions in the process via `Symbol.for("pi-me.dialog-lock")`, so mixed batches (`git_commit` + `slack_post_message`) serialize against one queue instead of clobbering each other across extensions.
- `tests/confirm.test.ts` pins the contract: FIFO order for concurrent confirms, mixed editor/confirm traffic, the shared `Symbol.for` key, and queue survival when a dialog throws.

## 1.3.0 — 2026-09-05

### Added
- **Image/video attachments on the three comment tools.** `git_pr_comment`, `git_issue_comment`, and `git_discussion_comment` take a new optional `images` param (local paths: png, jpg, jpeg, gif, webp, svg, mp4, mov, webm). Each file uploads to `https://uploads.github.com/user-attachments/assets` — the user-asset endpoint gh's own `--attach` flag (v2.99+) wraps — authenticated with `gh auth token` against the repository's numeric id, and `![name](url)` markdown is appended to the body, so the media renders inline on the PR, issue, or discussion. Going one level below `--attach` is deliberate: the flag does not exist for discussions (GraphQL-only), and one upload path keeps the three surfaces identical.
- `lib/attachment-upload.ts` — media-type detection/validation (same allowlist as gh), `gh auth token` + `gh api repos/<owner>/<repo> --jq .id` resolution, the byte POST (raw body, `Accept: application/vnd.github+json`, `Content-Type: application/octet-stream`, URLSearchParams query so `image/svg+xml` keeps its `+`), and error mapping: 404 = token lacks write access to the repo, 422 = type not allowed, plus raw status for the unknown tail.
- Ordering guarantee: paths are validated before the review dialog; uploads run after acceptance (cancel = zero side effects) and before the comment posts (failed upload = no comment, so no dangling references). 401/403 map to a re-auth hint; upload errors always end with "Comment NOT posted". GitHub keeps user-attachments forever (no auto-discard), so a partial batch failure names every file that uploaded before the failure plus its URL.
- Filenames containing `[`/`]`/newlines are sanitized in the appended `![alt](url)` alt text; a raw basename there could break the markdown construct in a posted comment.

### Review note
- Peer-reviewed before commit; both FIX-FIRST findings (orphan reporting, alt-text sanitization) are fixed above. The fork-workflow caveat (repository id resolves from the local checkout's remote) is documented in `lib/attachment-upload.ts`.

## 1.2.1 — 2026-09-03

### Fixed

- **`git_commit` no longer refuses a commit when a merge is in progress and nothing is staged.** The staged-changes pre-flight treated an empty index as "nothing to do", but mid-merge (`MERGE_HEAD` exists) git accepts exactly that: the commit itself records the merge, even with a zero content delta. Example: `git merge --no-commit` of an already-contained branch leaves a pure ancestry-marker merge that only `git commit` can finish. The old guard made that impossible through the sanctioned editable gate and pushed agents toward shell `git commit`, the exact bypass the policy forbids. The tool now probes `git rev-parse -q --verify MERGE_HEAD` only when the index is clean (no extra subprocess on the normal path); with a merge in progress it proceeds through the same gate (title reads "Commit in-progress merge with this message?", success echoes "Committed merge with"), and without one the usual "nothing staged" message stands. Deliberate `--allow-empty` non-merge commits stay out of scope.
- Tool description, binding policy guidance, and README row state the merge exception, so the old "requires staged changes" rule no longer reads as a dead end mid-merge.

### Tests

- 112 -> 114. New: merge-in-progress with a clean index reaches the gate and the title names the merge; clean index without MERGE_HEAD still refuses before the gate. The default `git rev-parse` mock route is narrowed to `--is-inside-work-tree` so it cannot answer the MERGE_HEAD probe.

## 1.2.0 — 2026-08-11

### Added

- **`git_issue_create`** — create a new GitHub issue via `gh issue create` with title + body (both edited in one review dialog, same as `git_pr_upsert`) and optional labels / assignees (repeated flags; `@me` works). Echoes the new issue URL. Closes the policy gap where "post as the user" content could only reach an issue someone else had created.
- **`git_discussion_create`** — start a new GitHub Discussion. There is no `gh discussion` CLI command, so this goes through the GraphQL API via `gh api graphql` (`createDiscussion` mutation). The category is required by NAME and resolved case-insensitively against the repo's category list before the review dialog; a wrong name returns the valid names (and an empty list reports that Discussions are probably disabled), so no dialog opens for a doomed write.
- **`git_discussion_comment`** — post a comment on a GitHub Discussion, or a threaded reply under a specific comment when `replyTo` carries that comment's id (numeric REST id — resolved to its node id — or a GraphQL node id, both discoverable read-only). Runs the `addDiscussionComment` mutation; omits `replyToId` entirely for top-level comments (an empty-string ID is not null to GraphQL). Issue comments stay flat: replying to an ISSUE remains `git_issue_comment`.
- `lib/github.ts` — shared GitHub plumbing beyond plain gh subcommands: `ghRepoView` (repo node id + owner/name via `gh repo view --json`), `ghGraphql` (typed-variable GraphQL over `gh api graphql`, failing on non-zero exit AND on 200-with-errors bodies), the discussion queries/mutations, and the numeric-comment-id → node-id resolver. Variables ride `-F key=value` flags on an args-array spawn, so no shell or GraphQL injection surface.
- Title+body editor prefill (single buffer, `---` separator, separator-deleted fallback) extracted from `git_pr_upsert` into shared `toTitleBodyPrefill` / `fromTitleBodyPrefill` helpers in `lib/format.ts` (`describePrPayload` renamed `describeTitleBodyPayload`); `git_issue_create` and `git_discussion_create` reuse it.
- `/git issue-create <title>`, `/git discussion-create <title>`, `/git discussion-comment <num>` slash-command verbs; `/git` status line and usage updated. The binding TOOL_GUIDANCE policy now covers issue creation and discussions: forbidden-via-shell list extended with `gh issue create` and write-shaped `gh api` calls (GraphQL mutations, REST POST/PATCH/DELETE), surface→tool map extended, and the gate descriptions name all eight write tools.

### Tests

- 72 -> 112. New coverage: issue create (cancel / headless / blanked-buffer / argv incl. repeated `--label` / `--assignee` flags / edited-draft details), discussion create (category resolution case-insensitive, unknown-category lists valid names before the gate, zero-categories hint, repo-view failure, graphql non-zero exit), discussion comment (top-level omits `replyToId`, numeric `replyTo` REST resolution, node-id passthrough, unresolvable `replyTo` fails pre-gate, unknown discussion number), and cwd threading for the new tools.

## 1.1.3 — 2026-08-11

### Changed
- **Write-tool results no longer echo the posted content when the draft was not edited.** The content block and `details` are now emitted only when the human changed the draft in the review dialog. When the draft shipped verbatim the agent already has that text in its own context, so echoing it duplicated tokens for no information gain. The success line stays terse (e.g. `Posted comment on PR #42.`).

## 1.1.2 — 2026-08-11

### Added
- **Write tools report the actual posted content and an `edited` flag.** `git_commit`, `git_pr_upsert`, `git_pr_comment`, `git_pr_review`, and `git_issue_comment` append a labeled "Edited by user: yes|no / Final content sent" block to the success result, so the agent's later turns know exactly what reached git or GitHub and whether the human changed the draft in the review dialog. The content is also mirrored into structured `details` as `{ postedContent, edited }`. Previously the body was echoed unlabeled (and `git_pr_upsert` truncated it to 200 characters), so after an edit the agent could keep believing its original draft had shipped verbatim.

### Changed
- The review gate accepts an optional `normalize` function used to compute the `edited` flag. The five write tools pass the same transformation they apply before transmission (`trimEnd`, and for `git_pr_upsert` the title/body split + trim), so a whitespace-only edit that is stripped before sending no longer registers as edited.
- `git_pr_upsert` no longer truncates the PR body to 200 characters in its success result; the full title and body are echoed.

## 1.1.1 — 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent`, `pi-tui` dev pins to `^0.84.0`. Audited against the pi v0.84.0 breaking changes (renamed `ModelsRequestTransforms`, null-tolerant `getApiKeyAndHeaders` headers, dropped `message_update` partial fields, v4 session APIs); no code changes were needed and `tsc`/`typecheck` passes against 0.84.0.

## 1.1.0 — 2026-07-31

### Added

- Optional `cwd` parameter on all 10 tools (`git_status`, `git_diff`,
  `git_log`, `git_current_branch`, `git_pr_info`, `git_commit`,
  `git_pr_upsert`, `git_pr_comment`, `git_pr_review`, `git_issue_comment`).
  Set it to operate on a different repository than the one pi was started
  in (a sibling repo, a subdirectory, a monorepo member). Omit it to keep
  the current behavior.

### Changed

- Tools now default their working directory to `ctx.cwd` (the agent's
  current directory) instead of `process.cwd()`. Same value in a normal pi
  run, but `ctx.cwd` is the source of truth, so a session that switched
  directories mid-run is honored. The `/git` command's repo guard follows
  the same default. Backward-compatible: every `cwd` argument is optional
  and the default matches prior behavior when pi is launched in a repo.
- When a write tool is redirected to a different repository via `cwd`, the
  review dialog now names that repository in its title (e.g. `Commit staged
  changes with this message? (repo: /path)`). Without this, an agent
  passing `cwd` could redirect a commit / PR / comment and the human review
  gate would not show it. The label appears only when the target differs
  from the session directory, so normal runs are unchanged.

## 1.0.0 — 2026-07-31

First stable release. Hardening pass from the 0.2.0 scaffold, driven by a
senior-engineer peer review of the tool wording and the apply paths. The
design contract did not change (agent drafts the prose, the human reviews it
in an editable dialog, nothing touches git or GitHub until accept); this
release makes the wording actually enforce that contract and fixes three
correctness bugs that could mislead the agent or post the wrong thing.

### Breaking

- Tool renames: `git_commit_message` -> `git_commit`, `git_pr_description`
  -> `git_pr_upsert`, and `git_review_comment` -> `git_pr_review`. The old
  names read as text generators (or, for review, collided with GitHub's own
  "review comment" = inline line-level comment term), so an agent told to
  "commit" or "open a PR" reached for the shell instead, or picked the
  review tool for a line-level comment request. The new names are verbs /
  unambiguous. `git_commit` still COMMITS; `git_pr_upsert` still CREATES or
  EDITS a PR; `git_pr_review` still posts a PR review event (summary / APPROVE
  / REQUEST_CHANGES), distinct from `git_pr_comment`. File and const names
  followed: `lib/tools/commit-message.ts` -> `commit.ts`, `pr-description.ts`
  -> `pr-upsert.ts`, `review-comment.ts` -> `pr-review.ts`. Update any prompt
  templates or configs that named the old tools. The other seven tool names
  are unchanged.
- Removed the `git-confirm-write` / `git-allow-headless-write` pi flags.
  They were registered but never read: pi extension flags are in-memory-only
  with no setter, so `pi --git-confirm-write=false` silently did nothing and
  `/settings` displayed the registered default while the on-disk state the
  gate reads could be the opposite. The authoritative surface is now the
  file-backed setting, toggled via `/git config`, `/git confirm on|off`, and
  `/git headless on|off`, and shown by the `/git` status line and the
  `/git config` modal.
- `package.json` no longer ships `tests/` and `vitest.config.ts` to
  consumers (dead weight, and the tests used to run in `prepublishOnly`).

### Tool wording (agent steering)

The 0.2.0 wording failed one of its two jobs: it forbade the agent shelling
out to `git` / `gh`, but said nothing about the agent bouncing the drafting
or the approval back to the human in chat ("want me to commit? what should
the message say?"). One permissive sentence ("You do NOT need to ask the
user yourself first") licensed exactly that failure.

- All five write-tool descriptions now lead with the ACTION ("COMMITS the
  staged changes", "OPENS a new pull request, or EDITS the existing one"),
  state the canonical rule, and end with: "DRAFTING IS YOUR JOB, NOT THE
  USER'S. Draft the text yourself and call this tool; the editable dialog is
  where the user reviews, edits, and approves. Do NOT ask the user in chat
  what to write, and do NOT ask for approval before calling. Do NOT run
  `<cmd>` through the bash/shell tool yourself."
- The `before_agent_start` `TOOL_GUIDANCE` block was restructured from a
  space-joined wall of 11 sentences into a bulleted, headed "binding policy"
  that names the bash tool explicitly (with a forbidden-command list),
  declares the dialog IS the asking and the approval, and adds a
  cancel-recovery rule (a `cancelled by user` result means Esc; do not retry
  via shell, do not ask the user to paste wording).
- The review tool is now `git_pr_review` (renamed from `git_review_comment`).
  The old name collided with GitHub's own "review comment" term (an inline
  line-level diff comment), inviting the wrong-tool pick. The description
  states it posts a review SUMMARY event and adds a LIMITATION: it cannot
  post inline line-level diff comments.
- Read-tool descriptions now lead with "PREFER THIS over running `<cmd>` in
  the shell" and note the cap the shell command lacks.
- `git_commit` description now states it commits ONLY staged changes and
  tells the agent to stage with `git add` via the shell first (there is no
  staging tool; without this, an empty-stage error pushed the agent to
  `git commit -a` via shell, bypassing the gate).
- The cancel-recovery rule now lets the user choose revise-or-cancel instead
  of forcing a revision loop (Esc often means abort the whole task).
- `git_pr_comment` / `git_pr_review` PR-number param descriptions no longer
  claim `git_pr_info` can discover other PRs' numbers (it only inspects the
  current branch).

### Fixed

- `gitLog` corrupted every multi-line commit body: records were split on
  `\n` but `%b` contains newlines, so each body line became a phantom entry
  with undefined hash/date/author. Switched to NUL-terminated records
  (`%x00`) and extracted a pure `parseGitLog` (unit-tested, incl. the
  multi-paragraph regression).
- `APPROVE` and `REQUEST_CHANGES` never set `requireInteractive`, so a
  formal, public, state-changing review could fire with the review gate off
  and unattended in headless mode. They are now forced: the editor opens
  even with `/git confirm off`, and they are BLOCKED in headless mode
  regardless of the headless opt-in. `COMMENT` keeps the normal prose path.
- `git_pr_upsert` resolved create-vs-edit AFTER the gate and addressed
  `gh pr edit` by branch, so the dialog never said whether it was creating a
  public PR or overwriting an existing one, and a branch checkout between
  resolve and apply could edit the wrong PR. It now resolves first (dialog:
  "Open a new PR" vs "Overwrite PR #N") and addresses `gh pr edit` by number.
- `git_pr_upsert` `fromPrefill` hard-failed after acceptance if the user
  deleted the `---` separator. It now falls back to the agent-supplied title
  and still applies.
- `git_commit` staged pre-flight moved before the gate (no point opening the
  editor on an empty stage).
- The four gh-backed write tools preflight `gh` presence and auth via the
  previously-dead `isGhAuthed()`, so a missing/unauthed `gh` surfaces one
  actionable error instead of a collapsed "no PR found" that sent the agent
  off to open a PR on a machine without `gh`.
- `gitDiff` measured the cap in UTF-16 code units but named it bytes; a
  CJK-heavy diff overshot ~3x. Now measured in UTF-8 bytes and sliced at a
  byte boundary.
- `spawnChecked` now distinguishes a timeout / kill signal (exit 124, clear
  message) from an ordinary non-zero exit, so a `gh` call blocking on a
  credential helper is not mistaken for a git error.
- `git_commit`'s async apply (`commitWithMessage`) had no timeout, so a hung
  pre-commit hook or a GPG/SSH signing TTY prompt would lock the agent turn
  forever. It now has a 30s timeout + SIGTERM + exit 124, matching
  `spawnChecked`.
- `git_pr_info` now runs the same repo + `gh` preflight as the write tools,
  so a missing repo or missing/unauthed `gh` surfaces one actionable error
  instead of a generic "no PR" that hid the cause.
- `writeSettings` (the gate's persistence) is now an atomic temp-file +
  rename, so a crash mid-write cannot leave a truncated settings file (which
  `readSettings` would silently reset to the safe defaults).

### Tests

- `node:child_process` is mocked in `tests/tools.test.ts`. The old suite
  shelled out to real `git` / `gh`, so the "surfaces no PR" test failed on a
  machine with an open PR for the cwd branch and ran in `prepublishOnly`.
  The suite is now deterministic and runs in ~0.3s (was ~12s).
- Added argv assertions for the apply paths: `APPROVE` -> `--approve`,
  `REQUEST_CHANGES` -> `--request-changes`, `COMMENT` -> `--comment`,
  `gh pr edit <number>` (number-addressed), `gh pr create` with title/body/
  base, `gh pr comment`, `gh issue comment`.
- Added `git_pr_upsert` coverage: create path, edit path (number-addressed,
  overwrite dialog), and separator-recovery fallback.
- Added gate-wiring coverage: `/git confirm off` skips the dialog for prose
  writes but APPROVE still prompts.
- Added `parseGitLog` unit tests including the multi-line body regression.
- 53 -> 72 tests.

### Removed (dead code)

`gitDiffStat`, `gitStatusPorcelain`, `ghPrFiles` (kept `parseGhFiles`), the
`GitPorcelainEntry` / `GitDiffStatLine` / `CommitMessageArgs` /
`PrDescriptionArgs` / `ReviewCommentArgs` types, and the unused
`DIFF_BYTE_CAP` constant.

## 0.2.0 — 2026-08-01

Two new write tools + scope clarification. The original 0.1.0 scaffold had
three write tools (commit message, PR description, PR review comment) and
described itself as covering "git + GitHub". This release makes the scope
explicit: this extension drives `git` (commit message only) and `gh`
(everything else) for GitHub today; other providers (GitLab, Gitea /
Forgejo, Bitbucket, etc.) are explicitly out of scope and the user wires
those up themselves via their preferred path (their own CLI, direct REST /
GraphQL, an MCP server, or a custom pi extension).

Every write-tool description now leads with a canonical-rule sentence:
"USE THIS for any X that will be posted as the user [into GitHub]". The
system-prompt guidance block (`TOOL_GUIDANCE` in `extensions/index.ts`)
also opens with the canonical rule and lists every surface -> tool mapping.

### Added

- `git_pr_comment` — post a top-level conversation comment on a pull request via `gh pr comment <number> --body`. Distinct from `git_review_comment`: that posts a REVIEW event (COMMENT / APPROVE / REQUEST_CHANGES) on the PR's review summary and may change the PR review state; this posts a plain comment on the PR conversation without touching the review state.
- `git_issue_comment` — post a comment on a GitHub issue via `gh issue comment <number> --body`. Issue number is required (issues have no equivalent of "current branch").
- `/git pr-comment [num]` and `/git issue-comment <num>` slash command verbs (prefill the editor with a draft-then-post prompt).
- Updated `/git` status line + bare `/git` help to list all 10 verbs.
- CHANGELOG / README "Scope" section: explicitly GitHub-today, other providers out of scope.

### Changed

- Reworded every write-tool description in `lib/prompts.ts` so the lead sentence is the canonical rule ("USE THIS for any X that will be posted as the user into GitHub") followed by the operational details. Title prefix: `"git: <Name> (GitHub via gh)"` for gh-specific tools; `"git: <Name>"` for the git-only commit-message tool.
- `TOOL_GUIDANCE` block in `extensions/index.ts` opens with the canonical rule and lists the surface -> tool mapping explicitly.
- README tool table grew from 8 to 10 rows and gained a CLI column (`git` vs `gh`). Notes section explains `git_pr_comment` vs `git_review_comment` and how to wire up other providers.

## 0.1.0 — 2026-08-01

Initial scaffold. Mirrors the pi-slack-me / pi-asana house style: file-backed
flag persistence, two-stage human-in-the-loop gate, headless guard, editable
preview dialog for every prose write, `/git` slash command with verbs and a
TUI settings modal.

### Added

- `git_status` — working-tree + branch status (`git status --branch --porcelain`), capped at 200 lines.
- `git_diff` — diff for `staged` / `unstaged` / `all` / `branch` with full `--stat` plus patch (capped at 50 KB by default).
- `git_log` — last N commits (default 10, max 100) as a structured list.
- `git_current_branch` — current branch name, or `HEAD (detached at <sha>)`.
- `git_pr_info` — `gh pr view` for the current branch: number, title, body, state, URL, base/head refs, draft flag, author, review decision. Returns null when there is no PR.
- `git_commit_message` — commit the staged changes with the agent's suggested subject + body. Edits in an editable dialog before applying via `git commit -F -`. Supports `--amend`. Pre-flights "nothing staged" before running.
- `git_pr_description` — create (`gh pr create`) or edit (`gh pr edit`) the PR for the current branch with the agent's suggested title + body. Both fields edited in one dialog. Pre-flights `gh auth status`.
- `git_review_comment` — post a PR review comment (`gh pr review --comment`, `--approve`, or `--request-changes`) with the agent's suggested body. Resolves PR number from the current branch by default; pass `pr` to target a different number.
- `lib/confirm.ts` — two-stage human-in-the-loop gate, file-backed at `<piDir>/pi-git-me.json` (pi extension flags are in-memory-only with no setter, so a settings file is required for durable state). Stage 1 is a HEADLESS guard (writes refused when no UI unless the explicit opt-in is set); stage 2 is the REVIEW gate, on by default.
- `git-confirm-write` flag (editable review on/off) + `git-allow-headless-write` flag (opt in to unsupervised writes, default off) + `/git config` (TUI settings modal, both rows) + `/git confirm on|off` + `/git headless on|off`.
- `/git` slash command with verbs: `status`, `diff`, `log`, `branch`, `pr`, `commit`, `pr-create`, `review`, `config`, `confirm`, `headless`. Bare `/git` prints env status + available verbs.
- `before_agent_start` hook injects a compact tool-guidance block (one paragraph; intentionally small).
- Tests: gate matrix (10 cases — confirmWrite × allowHeadlessWrite × hasUI × forced, plus persistence), format helper unit tests.

### House style

- Pure functions where they make the test matrix obvious (`formatCommitMessage`, `describePrPayload`, etc.); orchestration in the tool's `execute`.
- `tsc --noEmit` strict, ES2022 modules, `typebox` for parameter schemas.
- vitest, `isolate: true` so module caches do not leak between test files.
- No bot, no token, no OAuth: the extension drives the user's own `git` and `gh` setup. There is no secret to rotate.
