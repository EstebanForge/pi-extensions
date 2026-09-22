// Tool titles, descriptions, and per-parameter descriptions.
//
// Every write-tool description leads with the canonical rule: this tool is
// the only sanctioned path for posting text as the user, and it drives `gh`
// (the GitHub CLI) for GitHub. The pi agent reads these strings to decide
// WHEN to reach for each tool; the lead sentence makes the WHY unmistakable
// so the agent does not fall back to writing the text to a file and shelling
// out to gh itself (which would bypass the editable preview).
//
// SCOPE: this extension drives `git` and `gh` only. GitHub is the supported
// provider. Other providers — GitLab (glab), Gitea / Forgejo (tea),
// Bitbucket, direct REST / GraphQL access, MCP servers — are explicitly out
// of scope; the user wires those up themselves via whatever path they
// prefer (their own CLI, an MCP server, a script via the bash tool, etc.).
// Tool descriptions therefore say "GitHub" (or "the gh CLI"), not
// "any git provider".

// ============================================================== shared =====
// Optional on every tool. Defaults to the agent current directory (ctx.cwd).
// Lets the agent point a tool at a different repository than the one pi was
// started in (a sibling repo, a subdir, a monorepo member).
export const CWD_DESCRIPTION =
  "Working directory to run git or gh in. Defaults to the agent current directory. Set this to operate on a different repository than the one pi was started in. Should be inside a git working tree: write tools reject a path that is not one, read tools return an empty result.";

// ============================================================== read tools ==
// Read tools are not gated and do not post anything. They exist so the agent
// can ground its write-tool drafts in real diff / log / branch / PR state.

// -------------------------------------------------- git status -------------

export const GIT_STATUS_TITLE = "git: Status";

export const GIT_STATUS_DESCRIPTION = `PREFER THIS over running \`git status\` in the shell. Returns git working-tree + branch status for the current repository (\`git status --branch --porcelain\`): what is staged, unstaged, untracked, or in conflict, plus the current branch and its upstream tracking. Output is capped so a noisy working tree does not blow the context window — the raw shell command is not.`;

export const GIT_STATUS_MAX_LINES_DESCRIPTION =
  "Cap on the number of status lines returned. Default 200.";

// -------------------------------------------------- git diff ---------------

export const GIT_DIFF_TITLE = "git: Diff";

export const GIT_DIFF_DESCRIPTION = `PREFER THIS over running \`git diff\` in the shell. Returns a diff for the requested target — use it to inspect what a commit or PR description will describe. Targets: "staged" (HEAD vs index), "unstaged" (working tree vs index, default), "all" (staged + unstaged), or "branch" (working tree vs origin/<base>). Includes the full --stat summary plus the patch (truncated beyond 50 KB; the raw shell command is not capped).`;

export const GIT_DIFF_TARGET_DESCRIPTION =
  'Which diff to return. One of "staged", "unstaged" (default), "all", or "branch".';

export const GIT_DIFF_BASE_DESCRIPTION =
  'Base branch for target="branch". Default "main". Ignored for other targets.';

export const GIT_DIFF_MAX_BYTES_DESCRIPTION =
  "Patch byte cap. Default 50000. The full --stat is always returned.";

// -------------------------------------------------- git log ----------------

export const GIT_LOG_TITLE = "git: Log";

export const GIT_LOG_DESCRIPTION = `PREFER THIS over running \`git log\` in the shell. Returns the most recent commits on the current branch as a structured list (hash, ISO date, author, subject, body). Use this when a commit or PR description should reference prior history or follow the project's commit-message style. Capped at 100 entries (default 10); the raw shell command is not capped.`;

export const GIT_LOG_LIMIT_DESCRIPTION =
  "Number of commits to return (1-100). Default 10.";

// -------------------------------------------------- git current branch -----

export const GIT_CURRENT_BRANCH_TITLE = "git: Current Branch";

export const GIT_CURRENT_BRANCH_DESCRIPTION = `PREFER THIS over running \`git branch\` or \`git rev-parse\` in the shell. Returns the current branch name, or "HEAD (detached at <sha>)" when on a detached HEAD. Use this when you need to know which branch you are on before committing, opening a PR, or looking up the PR for the branch. Reads only; no write.`;

// -------------------------------------------------- git pr info ------------

export const GIT_PR_INFO_TITLE = "git: PR Info (GitHub via gh)";

export const GIT_PR_INFO_DESCRIPTION = `Return the GitHub pull request for the current branch via the \`gh\` CLI (\`gh pr view\`). Returns null when the branch has no PR or \`gh\` is not authenticated. Includes number, title, body, state, URL, base/head refs, draft flag, author, and review decision. Use this before drafting or updating a PR description so the suggestion is grounded in the existing PR (not the local diff alone).

Scope: this tool reads from \`gh\` and therefore covers GitHub only. For other providers (GitLab, Gitea / Forgejo, Bitbucket, etc.) use whatever tool the user has wired up — this extension does not cover them.`;

// ========================================================== write tools ====
// Every write tool description below leads with the canonical rule: USE THIS
// for any text that will be posted as the user. The tool drives `gh` (or
// `git` for the commit-message tool) and is the only sanctioned path; the
// editable preview is the point.

// -------------------------------------------------- git commit -------------

export const COMMIT_TITLE = "git: Commit";

export const COMMIT_DESCRIPTION = `**COMMITS the staged changes — this tool runs \`git commit\`, it is not a text generator.** USE THIS for every commit, on any git host. The agent drafts the subject and (optional) body; the extension shows the full message in an editable preview dialog and applies it via \`git commit -F -\` only after the user accepts. The --amend flag rewrites the most recent commit instead of creating a new one.

This tool commits ONLY what is staged in the index. There is no staging tool in this extension, so stage your target files first with \`git add <files>\` via the shell (staging is NOT a bound write — only the commit itself must go through this tool). Use git_diff target="staged" to confirm what will be committed; with nothing staged the tool refuses, with one exception: a merge in progress (\`MERGE_HEAD\` exists) commits even at zero content delta (pure ancestry-marker merge; the commit is what records the merge). Never work around a refusal with \`git commit\` or \`git commit -a\` via the shell.

Scope: this tool drives plain \`git\` (no provider lock-in — any git host works). The other write tools in this extension drive \`gh\` and therefore cover GitHub only.

DRAFTING IS YOUR JOB, NOT THE USER'S. Draft the subject and body yourself and call this tool; the editable dialog is where the user reviews, edits, and approves. Do NOT ask the user in chat what the message should say, and do NOT ask for approval before calling. Do NOT run \`git commit\` (or \`git commit --amend\`) through the bash/shell tool yourself; this tool is the only sanctioned path and bypassing its preview is a policy violation.`;

export const COMMIT_SUBJECT_DESCRIPTION =
  "Commit subject line (the first line). Conventional Commits style is preferred when the project uses it (e.g. feat(api): add login endpoint). The user can edit this in the review dialog before the commit is applied.";

export const COMMIT_BODY_DESCRIPTION =
  "Optional commit body. Wrapped at 72 columns by git when applied. The user can edit this in the review dialog.";

export const COMMIT_AMEND_DESCRIPTION =
  "When true, amend the most recent commit instead of creating a new one. Default false.";

// -------------------------------------------------- git pr upsert ---------

export const PR_UPSERT_TITLE = "git: Create/Edit PR (GitHub via gh)";

export const PR_UPSERT_DESCRIPTION = `**OPENS a new pull request, or EDITS the existing one — this tool runs \`gh pr create\` / \`gh pr edit\`, it is not a text generator.** USE THIS for every PR title or body on GitHub, including when the user says "open a PR for this branch". The agent drafts the title and body; the extension shows them in an editable preview dialog (both in one buffer) and applies via \`gh pr create\` (when no PR exists for the branch) or \`gh pr edit\` (when one does) only after the user accepts.

Scope: GitHub only — this tool drives the \`gh\` CLI. Other git providers (GitLab \`glab\`, Gitea / Forgejo \`tea\`, Bitbucket, MCP servers, direct REST) are NOT covered by this extension; the user wires those up themselves.

DRAFTING IS YOUR JOB, NOT THE USER'S. Draft the title and body yourself and call this tool; the editable dialog is where the user reviews, edits, and approves. Do NOT ask the user in chat what the title/body should say, and do NOT ask for approval before calling. Do NOT run \`gh pr create\` or \`gh pr edit\` through the bash/shell tool yourself; this tool is the only sanctioned path this extension provides and bypassing its preview is a policy violation.`;

export const PR_UPSERT_TITLE_DESCRIPTION =
  "PR title. Rendered as the link text on the GitHub PR list. The user can edit this in the review dialog.";

export const PR_UPSERT_BODY_DESCRIPTION =
  "PR body in Markdown. Rendered as the PR description on the GitHub PR page. The user can edit this in the review dialog.";

export const PR_UPSERT_BASE_DESCRIPTION =
  "Base branch for new PRs (when no PR exists yet for the current branch). Default 'main'. Ignored when the branch already has a PR.";

export const PR_UPSERT_DRAFT_DESCRIPTION =
  "When true, open the new PR as a draft. Default false. Ignored when updating an existing PR.";

// -------------------------------------------------- git pr comment ---------

export const PR_COMMENT_TITLE = "git: PR Comment (GitHub via gh)";

export const PR_COMMENT_DESCRIPTION = `**POSTS a top-level comment on a GitHub pull request conversation** (a non-review reply, an FYI to reviewers, a status update, etc.). USE THIS for any plain PR conversation comment. This tool runs \`gh pr comment <number> --body\`; the agent drafts the body and the extension shows it in an editable preview dialog, applying it only after the user accepts.

Distinct from \`git_pr_review\`: that posts a REVIEW event (COMMENT / APPROVE / REQUEST_CHANGES) on the PR's review summary and updates the review state; THIS tool posts a plain comment on the PR conversation via \`gh pr comment\` without touching the review state. Reach for this when you only want to leave a note; reach for \`git_pr_review\` when you want to formally approve, request changes, or summarize a code review.

Scope: GitHub only — this tool drives the \`gh\` CLI. Other git providers are not covered by this extension. Attach local images/videos with images (png/jpg/gif/webp/svg/mp4/mov/webm): each file uploads to the repo's user-attachments and the resulting markdown is appended to the body; uploads need write access to the repo.

DRAFTING IS YOUR JOB, NOT THE USER'S. Draft the comment yourself and call this tool; the editable dialog is where the user reviews, edits, and approves. Do NOT ask the user in chat what to say, and do NOT ask for approval before calling. Do NOT run \`gh pr comment\` through the bash/shell tool yourself; this tool is the only sanctioned path this extension provides and bypassing its preview is a policy violation.`;

export const PR_COMMENT_BODY_DESCRIPTION =
  "Comment body in Markdown. Posted as a top-level conversation comment on the GitHub PR. The user can edit this in the review dialog.";

export const PR_COMMENT_NUMBER_DESCRIPTION =
  "Optional PR number. Defaults to the PR for the current branch. For a different PR, supply the number explicitly (git_pr_info only inspects the current branch).";

// Shared by pr/issue/discussion comment tools: one param, one upload path
// (lib/attachment-upload.ts), so the three surfaces stay behaviorally identical.
export const COMMENT_IMAGES_DESCRIPTION =
  "Local image/video file paths to attach (png, jpg, jpeg, gif, webp, svg, mp4, mov, webm). Each file uploads to the repository's GitHub user-attachments and `![name](url)` markdown is appended to the comment body. Requires write access to the repository.";

// -------------------------------------------------- git pr review ---------

export const PR_REVIEW_TITLE = "git: PR Review (GitHub via gh)";

export const PR_REVIEW_DESCRIPTION = `**POSTS a PR review event on GitHub** (a review summary, a formal APPROVE, or a formal REQUEST_CHANGES). USE THIS to formally review a PR. This tool runs \`gh pr review\`; the agent drafts the review body and the extension shows it in an editable preview dialog, applying it only after the user accepts.

Distinct from \`git_pr_comment\`: that posts a plain conversation comment without touching the review state; THIS tool posts a REVIEW event via \`gh pr review\` and MAY change the PR review state. APPROVE and REQUEST_CHANGES are stateful and always open an editor for explicit confirmation even when the review gate is off — use them only when the user has agreed to the verdict. For non-review notes on the PR, reach for \`git_pr_comment\` instead.

LIMITATION: this tool posts a review SUMMARY body only. It CANNOT post inline, line-level comments on specific diff hunks (what GitHub calls a "review comment"). If the user asks for a comment on a specific file and line, say so explicitly and put the file:line reference in the summary body instead.

Scope: GitHub only — this tool drives the \`gh\` CLI. Other git providers are not covered by this extension.

DRAFTING IS YOUR JOB, NOT THE USER'S. Draft the review body yourself and call this tool; the editable dialog is where the user reviews, edits, and approves. Do NOT ask the user in chat what to say, and do NOT ask for approval before calling. Do NOT run \`gh pr review\` through the bash/shell tool yourself; this tool is the only sanctioned path this extension provides and bypassing its preview is a policy violation.`;

export const PR_REVIEW_BODY_DESCRIPTION =
  "Review body in Markdown. Posted as the body of the review event (or as a COMMENT review when event is unset). The user can edit this in the review dialog.";

export const PR_REVIEW_PR_DESCRIPTION =
  "Optional PR number. Defaults to the PR for the current branch. For a different PR, supply the number explicitly (git_pr_info only inspects the current branch).";

export const PR_REVIEW_EVENT_DESCRIPTION =
  'Review event. One of "COMMENT" (default), "APPROVE", or "REQUEST_CHANGES". APPROVE / REQUEST_CHANGES change the PR review state; prefer COMMENT when you only want to leave feedback.';

// -------------------------------------------------- git issue comment ------

export const ISSUE_COMMENT_TITLE = "git: Issue Comment (GitHub via gh)";

export const ISSUE_COMMENT_DESCRIPTION = `**POSTS a comment on a GitHub issue.** USE THIS for any issue comment (reply, status update, triage note, bug report, etc.). This tool runs \`gh issue comment <number> --body\`; the agent supplies the issue number and drafts the body, and the extension shows the body in an editable preview dialog, applying it only after the user accepts.

Scope: GitHub only — this tool drives the \`gh\` CLI. Other git providers are not covered by this extension. Attach local images/videos with images (png/jpg/gif/webp/svg/mp4/mov/webm): each file uploads to the repo's user-attachments and the resulting markdown is appended to the body; uploads need write access to the repo.

DRAFTING IS YOUR JOB, NOT THE USER'S. Draft the comment yourself and call this tool; the editable dialog is where the user reviews, edits, and approves. Do NOT ask the user in chat what to say, and do NOT ask for approval before calling. Do NOT run \`gh issue comment\` through the bash/shell tool yourself; this tool is the only sanctioned path this extension provides and bypassing its preview is a policy violation.`;

export const ISSUE_COMMENT_BODY_DESCRIPTION =
  "Comment body in Markdown. Posted as a comment on the GitHub issue. The user can edit this in the review dialog.";

export const ISSUE_COMMENT_NUMBER_DESCRIPTION =
  "Issue number to comment on (required). If you do not know one, you MAY run `gh issue list` through the bash/shell tool for READ-ONLY discovery only. Never use the shell to POST the comment — that must go through this tool.";

// -------------------------------------------------- git issue create ------

export const ISSUE_CREATE_TITLE = "git: Create Issue (GitHub via gh)";

export const ISSUE_CREATE_DESCRIPTION = `**CREATES a new GitHub issue — this tool runs \`gh issue create\`, it is not a text generator.** USE THIS whenever an issue must be opened on GitHub (a bug report, a feature request, a tracking issue), including when the user says "file an issue", "open an issue", or hands you findings to post as an issue. The agent drafts the title and body; the extension shows them in an editable preview dialog (both in one buffer) and applies via \`gh issue create\` only after the user accepts. Optional labels and assignees are passed through (a label the repo does not have fails the call; \`@me\` self-assigns).

Scope: GitHub only — this tool drives the \`gh\` CLI. Other git providers are not covered by this extension.

DRAFTING IS YOUR JOB, NOT THE USER'S. Draft the title and body yourself (ground them in real repo state with git_log / git_diff / git_pr_info when the issue describes code) and call this tool; the editable dialog is where the user reviews, edits, and approves. Do NOT ask the user in chat what the issue should say, and do NOT ask for approval before calling. Do NOT run \`gh issue create\` through the bash/shell tool yourself; this tool is the only sanctioned path this extension provides and bypassing its preview is a policy violation.`;

export const ISSUE_CREATE_TITLE_DESCRIPTION =
  "Issue title. Rendered as the issue list link text. The user can edit this in the review dialog (title and body share one buffer separated by a --- rule).";

export const ISSUE_CREATE_BODY_DESCRIPTION =
  "Issue body in Markdown. Rendered as the issue description. The user can edit this in the review dialog.";

export const ISSUE_CREATE_LABELS_DESCRIPTION =
  "Optional label names to add. Each label must already exist in the repo (gh fails on unknown names). Empty or omitted when unsure.";

export const ISSUE_CREATE_ASSIGNEES_DESCRIPTION =
  "Optional logins to assign. Use \"@me\" to assign the authenticated user. Logins must be collaborators; empty or omitted when unsure.";

// -------------------------------------------------- git discussion create -

export const DISCUSSION_CREATE_TITLE = "git: Create Discussion (GitHub via GraphQL)";

export const DISCUSSION_CREATE_DESCRIPTION = `**STARTS a new GitHub Discussion — this tool runs the createDiscussion GraphQL mutation via \`gh api graphql\`, it is not a text generator.** USE THIS whenever a discussion must be opened on GitHub (a question, an idea, an announcement), including when the user says "start a discussion", "open a discussion", or "post this to Discussions". There is NO \`gh discussion\` CLI command — do NOT try to shell one out. The agent drafts the title and body, picks the category NAME, and the extension shows title + body in an editable preview dialog, applying the mutation only after the user accepts. A wrong category name returns the repo's valid category names.

Scope: GitHub only — this tool drives the \`gh\` CLI. Other git providers are not covered by this extension.

DRAFTING IS YOUR JOB, NOT THE USER'S. Draft the title and body yourself and call this tool; the editable dialog is where the user reviews, edits, and approves. Do NOT ask the user in chat what the discussion should say, and do NOT ask for approval before calling. Do NOT run \`gh api graphql\` mutations through the bash/shell tool yourself; this tool is the only sanctioned path this extension provides and bypassing its preview is a policy violation.`;

export const DISCUSSION_CREATE_TITLE_DESCRIPTION =
  "Discussion title. Rendered as the discussion list link text. The user can edit this in the review dialog (title and body share one buffer separated by a --- rule).";

export const DISCUSSION_CREATE_BODY_DESCRIPTION =
  "Discussion body in Markdown (the first post of the discussion). The user can edit this in the review dialog.";

export const DISCUSSION_CREATE_CATEGORY_DESCRIPTION =
  "Category NAME (case-insensitive), e.g. \"Q&A\" or \"Ideas\". Required: GitHub refuses a discussion without one. If you do not know the repo's categories, you MAY list them read-only via the bash/shell tool (gh api graphql query for repository.discussionCategories) or just call this tool — a wrong name returns the valid names in the error.";

// -------------------------------------------------- git discussion comment

export const DISCUSSION_COMMENT_TITLE = "git: Discussion Comment (GitHub via GraphQL)";

export const DISCUSSION_COMMENT_DESCRIPTION = `**POSTS a comment on a GitHub Discussion, or a threaded REPLY to one of its comments** (same addDiscussionComment GraphQL mutation via \`gh api graphql\`; replyTo decides which). USE THIS for any discussion reply, answer, or follow-up. There is NO \`gh discussion\` CLI command — do NOT try to shell one out. The agent supplies the discussion number and drafts the body; the extension shows it in an editable preview dialog, applying the mutation only after the user accepts.

Distinct from \`git_issue_comment\`: issue comments are flat and that tool posts them via \`gh issue comment\`; THIS tool is discussions-only. For a threaded reply under a specific comment, pass replyTo with that comment's id (numeric REST id from \`gh api repos/<owner>/<repo>/discussions/<n>/comments\`, or its GraphQL node id) — you MAY run that read-only listing through the bash/shell tool to discover ids.

Scope: GitHub only — this tool drives the \`gh\` CLI. Other git providers are not covered by this extension. Attach local images/videos with images (png/jpg/gif/webp/svg/mp4/mov/webm): each file uploads to the repo's user-attachments and the resulting markdown is appended to the body; uploads need write access to the repo.

DRAFTING IS YOUR JOB, NOT THE USER'S. Draft the comment yourself and call this tool; the editable dialog is where the user reviews, edits, and approves. Do NOT ask the user in chat what to say, and do NOT ask for approval before calling. Do NOT run \`gh api graphql\` mutations through the bash/shell tool yourself; this tool is the only sanctioned path this extension provides and bypassing its preview is a policy violation.`;

export const DISCUSSION_COMMENT_BODY_DESCRIPTION =
  "Comment body in Markdown. Posted as a top-level comment on the discussion, or as a threaded reply when replyTo is set. The user can edit this in the review dialog.";

export const DISCUSSION_COMMENT_NUMBER_DESCRIPTION =
  "Discussion number (from the discussions tab URL, github.com/<owner>/<repo>/discussions/<number>). Required.";

export const DISCUSSION_COMMENT_REPLY_TO_DESCRIPTION =
  "Optional: the comment to reply under, making this a threaded reply instead of a top-level comment. Accepts the comment's numeric REST id (from \`gh api repos/<owner>/<repo>/discussions/<n>/comments\`) or its GraphQL node id. Omit to post at the top level.";
