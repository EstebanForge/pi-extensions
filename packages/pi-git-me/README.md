# @estebanforge/pi-git-me

Git + **GitHub** PR tools for the [pi coding agent](https://pi.dev) that act as **you**. Adds 13 LLM-callable tools that talk to local `git` (for the commit-message tool) and the authenticated `gh` CLI (for everything else). Five read tools (status, diff, log, branch, PR info) plus eight write tools (commit message, PR description, PR conversation comment, PR review comment, issue comment, issue creation, discussion creation, discussion comment/reply). Every write opens in an editable preview dialog before anything reaches git or GitHub — model picks the wording, you stay in control.

Use it when you want an agent to **inspect the working state** of a repo (diff, log, branch, current PR) **or post anything as you** into GitHub (commit message, PR title/body, PR conversation comment, PR review comment, issue comment, new issues, discussions and their comments). The agent drafts the prose; you read it, trim it, or cancel. Nothing commits, opens a PR or issue, starts a discussion, or posts anything until you say so.

## Canonical rule

**Any text the agent intends to record or post as you into git or GitHub MUST go through one of the git-me write tools.** Never fabricate the text and run `git` or `gh` through the bash/shell tool yourself — the editable preview is the point and bypassing it is a policy violation. Drafting is the agent's job: it writes the message or body itself and hands it to the tool, where you review, edit, and accept (Enter) or cancel (Esc). The agent must not ask you in chat for the wording or for approval before calling the tool — the dialog is the asking and the approval. The write tools are the only sanctioned path for:

- commit messages → `git_commit`
- PR titles and bodies → `git_pr_upsert`
- top-level PR conversation comments → `git_pr_comment`
- PR review events (COMMENT / APPROVE / REQUEST_CHANGES) → `git_pr_review`
- issue comments → `git_issue_comment`
- new issues → `git_issue_create`
- new discussions → `git_discussion_create`
- discussion comments and threaded discussion replies → `git_discussion_comment`

## Why a local `git` + `gh` setup (and not a GitHub App)

The extension drives the **same tools you use by hand**. `git` for the local repo (works for any branch, any host, any fork — only the commit-message tool needs `git`) and `gh` for GitHub-specific things (PR create / edit, PR comment, PR review, issue comment). No OAuth dance, no app registration, no secret rotation — `gh` already manages its own auth. The extension shells out to them and lets the user gate every write with an editable preview.

The tradeoff: the extension depends on `gh` for the GitHub-facing tools. If you do not have `gh` installed (or are not authenticated), those tools will surface a clear error instead of running blind. The commit-message tool only needs `git`.

## Scope: GitHub today, other providers out of scope

This extension drives `git` and `gh` **only**. GitHub is the supported provider.

Other git providers — GitLab, Gitea / Forgejo, Bitbucket, Gitea Enterprise, sourcehut, etc. — are **not** covered by this extension. The user wires those up themselves via whatever path they prefer:

- their own CLI (`glab` for GitLab, `tea` for Gitea / Forgejo)
- direct REST / GraphQL API access via the bash tool
- a separate MCP server (e.g. `mcp-server-gitlab`)
- a custom pi extension

The git-me tools will not interfere with those; they only handle `git` and `gh` invocations.

## Tools

| Tool | Read/Write | CLI | Purpose |
| --- | --- | --- | --- |
| `git_status` | read | `git` | Working-tree + branch status (`git status --branch --porcelain`). |
| `git_diff` | read | `git` | Diff for `staged` / `unstaged` (default) / `all` / `branch` with full `--stat` plus capped patch. |
| `git_log` | read | `git` | Most recent commits (hash, ISO date, author, subject, body). |
| `git_current_branch` | read | `git` | Current branch name (or detached-HEAD SHA). |
| `git_pr_info` | read | `gh` | PR for the current branch (number, title, body, URL, draft flag, review decision) — `null` when none. |
| `git_commit` | write | `git` | Commit staged changes, or finish an in-progress merge (works with an empty index). Agent's suggested subject + body. Opens an editable preview; applies via `git commit -F -`. |
| `git_pr_upsert` | write | `gh` | Create or edit the PR title + body for the current branch. Opens an editable preview; creates via `gh pr create` when no PR exists, or edits via `gh pr edit` when one does. |
| `git_pr_comment` | write | `gh` | Post a top-level PR conversation comment; attach local images/videos with `images`. Opens an editable preview; applies via `gh pr comment` (does not touch the PR review state — use `git_pr_review` for that). |
| `git_pr_review` | write | `gh` | Post a PR review event. Opens an editable preview; applies via `gh pr review --comment` (or `--approve` / `--request-changes`). |
| `git_issue_comment` | write | `gh` | Post a comment on a GitHub issue; attach local images/videos with `images`. Opens an editable preview; applies via `gh issue comment <number> --body`. |
| `git_issue_create` | write | `gh` | Create a new GitHub issue (title + body, optional labels/assignees). Opens an editable preview; applies via `gh issue create`. |
| `git_discussion_create` | write | `gh` (GraphQL) | Start a new GitHub Discussion in a named category. Opens an editable preview; applies via the `createDiscussion` mutation (`gh api graphql`). |
| `git_discussion_comment` | write | `gh` (GraphQL) | Post a comment on a discussion, or a threaded reply under a comment (`replyTo`); attach local images/videos with `images`. Opens an editable preview; applies via the `addDiscussionComment` mutation. |

The agent drafts the prose (commit message, PR title/body, PR comment, review body, issue title/body and comment, discussion title/body and comments); the user always sees it, can edit it, and can cancel.

## Write tools & review

The eight write tools gate themselves. A user is present at the TUI:

- **`git_commit`**, **`git_pr_upsert`**, **`git_pr_comment`**, **`git_pr_review`**, **`git_issue_comment`**, **`git_issue_create`**, **`git_discussion_create`**, **`git_discussion_comment`** open an **editable** dialog — trim or rewrite the agent's draft, then accept (Enter) or cancel (Esc).

In **headless mode** (no interactive UI, e.g. an unsupervised or automated run), the write tools are **refused by default** — the extension will not commit, edit a PR, post a comment, or post a review on your behalf without a human present. Opt in with `/git headless on` (persisted as the `git-allow-headless-write` setting) if you genuinely want unsupervised writes (e.g. scheduled/automation use).

The editable review is on by default and is governed by the `git-confirm-write` setting (toggle: `/git confirm on|off` or `/git config`). These are file-backed settings, not pi CLI flags — pi extension flags are in-memory-only and cannot durably reflect a toggle, so `/git config` and the `/git` status line are the authoritative surfaces.

| Command | Effect |
| --- | --- |
| `/git config` | Settings modal (TUI) — toggle the write review gate; status line elsewhere. |
| `/git confirm on` / `/git confirm off` | One-shot toggle. |
| `/git headless on` / `/git headless off` | One-shot toggle. |

## Image & video attachments on comments

The three comment tools (`git_pr_comment`, `git_issue_comment`, `git_discussion_comment`) accept an `images` param: local file paths (png, jpg, jpeg, gif, webp, svg, mp4, mov, webm). Each file uploads to GitHub's user-attachments endpoint — the same one `gh`'s own `--attach` flag uses — and `![name](url)` markdown is appended to the comment body, so the media renders inline on the issue, PR, or discussion.

Details worth knowing:

- The direct endpoint is used instead of the `--attach` flag because the flag exists only on `gh issue comment` / `gh pr comment`, while discussion comments are GraphQL-only; one upload path covers all three surfaces.
- Uploads need **write access** to the repository (read-only tokens get a 404 from the endpoint; the error says so). Uploading on behalf of a repo you can read but not push to is not possible — same limit the web UI's drag-and-drop does not have, because the browser session there is you-when-signed-in.
- Uploads run AFTER you accept the review dialog (cancel = zero side effects) and BEFORE the comment posts (a failed upload means no comment, so no dangling references). Uploaded-but-unposted assets stay on GitHub's user-attachments storage, unreferenced and invisible unless the URL is used.
- Paths are checked (exists + supported type) before the review dialog opens.
- Size limits match the web flow: 10 MB for images/GIFs, 10 MB video on free plans, 100 MB on paid plans.

## Install

```bash
pi install npm:@estebanforge/pi-git-me
```

Or add it to your pi package config:

```json
{
  "packages": {
    "@estebanforge/pi-git-me": "latest"
  }
}
```

## Upgrading from 0.2.0

1.0.0 renames three tools so the agent reaches for the action, not a text generator (and so the review tool stops colliding with GitHub's "review comment" term):

- `git_commit_message` -> **`git_commit`**
- `git_pr_description` -> **`git_pr_upsert`**
- `git_review_comment` -> **`git_pr_review`**

Update any prompt templates or slash-command prefills that named the old tools. The other seven tool names are unchanged. 1.0.0 also removes the non-functional `git-confirm-write` / `git-allow-headless-write` pi flags (they never affected the gate); toggle the review gate via `/git confirm on|off` or `/git config`. See [CHANGELOG.md](./CHANGELOG.md) for the full hardening list.

## Prerequisites

| Tool | Required for | How to install |
| --- | --- | --- |
| `git` | every tool | any modern Git (>= 2.30 recommended) |
| `gh` | the eight GitHub-touching tools (`git_pr_info`, `git_pr_upsert`, `git_pr_comment`, `git_pr_review`, `git_issue_comment`, `git_issue_create`, `git_discussion_create`, `git_discussion_comment`) | [cli.github.com](https://cli.github.com) — then `gh auth login` |

The extension reads **no environment variables**. There is no token to copy; `gh` is the auth surface. If `gh` is missing, the read tools still work; the GitHub write tools surface a clear error.

## Commands

| Command | Description |
| --- | --- |
| `/git` | Status line: cwd is a repo, `gh` is ready, write review gate state, headless opt-in state, verbs available. |
| `/git status` | Prefills the editor with a call to `git_status`. |
| `/git diff [target]` | Prefills with `git_diff` for the target (default `unstaged`; also `staged` / `all` / `branch`). |
| `/git log [N]` | Prefills with `git_log` for the last N commits (default 10). |
| `/git branch` | Prefills with `git_current_branch`. |
| `/git pr` | Prefills with `git_pr_info`. |
| `/git commit <subject>` | Prefills with a prompt to draft + commit. Hit Enter to run. |
| `/git pr-create <title>` | Prefills with a prompt to draft + open/edit the PR for the branch. Hit Enter to run. |
| `/git pr-comment [num]` | Prefills with a prompt to draft + post a top-level PR conversation comment. |
| `/git review` | Prefills with a prompt to draft + post a PR review event. |
| `/git issue-comment <num>` | Prefills with a prompt to draft + post an issue comment. |
| `/git issue-create <title>` | Prefills with a prompt to draft + open a new issue. |
| `/git discussion-create <title>` | Prefills with a prompt to draft + start a new discussion (category required). |
| `/git discussion-comment <num>` | Prefills with a prompt to draft + post a discussion comment or threaded reply. |
| `/git config` | Settings modal (write review gate). |
| `/git confirm on\|off` | Toggle the write review gate (one-shot). |
| `/git headless on\|off` | Toggle unsupervised (no-UI) write opt-in. |

You do not need to use the slash command. The agent reaches for these tools whenever a request touches git or GitHub state.

## Examples

```
What files are staged?
```
```
Show me the diff between this branch and main.
```
```
Open a PR for this branch with a description based on the changes.
```
```
Draft a commit message for the staged changes using our house style.
```
```
What PR is open for this branch?
```
```
Post a top-level comment on PR #123: "Tests are green on my end."
```
```
Post a review on PR #123 with: looks good, one nit on error handling.
```
```
Comment on issue #42 with: reproduced on main; bisect points to #39.
```
```
Open an issue titled "Flaky test: login E2E" with a body from the last CI run.
```
```
Start a discussion in Ideas titled "Weekly digest of merged PRs" — draft the first post.
```
```
Reply under the top comment of discussion #12: this worked for me on 1.2.3.
```

## Notes

- These tools make real calls against your local repo and (for the GitHub tools) your authenticated GitHub account. Write tools prompt you for review before touching git or GitHub when the write review gate is on (default); see [Write tools & review](#write-tools--review).
- `git_pr_comment` (top-level PR conversation comment via `gh pr comment`) is distinct from `git_pr_review` (PR review event via `gh pr review`). The first posts a comment on the PR conversation; the second posts a review that may change the PR review state (APPROVE / REQUEST_CHANGES). Reach for `git_pr_comment` when you only want to leave a note; reach for `git_pr_review` when you want to formally approve, request changes, or summarize a review.
- Headless mode: with no interactive UI, writes are refused unless `/git headless on` is set. The `APPROVE` and `REQUEST_CHANGES` event types for `git_pr_review` are stateful and hard to reverse, so they are ALWAYS forced through the review dialog (even with `/git confirm off`) and are BLOCKED in headless mode regardless of the headless opt-in — run them from an interactive session. Prefer `COMMENT` when you only want to leave feedback.
- The tools read git state from the cwd at the moment the tool runs. If the working tree changes between a `git_diff` call and the `git_commit` apply, the agent will see the updated diff via the next read; the commit applies to whatever is staged at apply time.
- `git_pr_upsert` decides create-vs-edit by calling `gh pr view` first. If your branch has a PR you did not create (rare), the title and body will overwrite the existing one in place.
- `git_pr_comment` and `git_pr_review` resolve the PR number from the current branch first; pass `pr` explicitly to target a different number.
- `git_issue_comment` requires an explicit issue number (issues have no equivalent of "current branch"). Use a read tool or `gh issue list` to discover issue numbers. Issue comments are flat (no threading) — the same tool is the reply path for issues.
- `git_issue_create` needs `gh issue create` to succeed; a label the repo does not have fails the whole call (nothing is created). Verify label names read-only first if unsure.
- Discussions have **no `gh` CLI command**. `git_discussion_create` and `git_discussion_comment` go through the GraphQL API via `gh api graphql` (the `createDiscussion` and `addDiscussionComment` mutations). A category **name** is required to create a discussion; a wrong name returns the repo's valid category names, so a first call is a safe way to discover them. Discussions must be enabled on the repo (Settings -> Features) or the category lookup reports it.
- `git_discussion_comment` posts top-level by default; pass `replyTo` with a comment id (numeric REST id or GraphQL node id, discoverable read-only via `gh api repos/<owner>/<repo>/discussions/<n>/comments`) to thread the reply under that comment.
- Other git providers (GitLab, Gitea / Forgejo, Bitbucket, etc.) are out of scope. Wire those up yourself via your preferred path (their CLI, direct API, MCP server, or a custom extension). See [Scope](#scope-github-today-other-providers-out-of-scope).

## License

MIT

Based on the [GitHub CLI (`gh`)](https://cli.github.com) and the [Conventional Commits](https://www.conventionalcommits.org/) format.
