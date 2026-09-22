/**
 * pi-git-me - git + GitHub tools for pi that act as YOU.
 *
 * Adds 13 LLM-callable tools that talk to local `git` and the authenticated
 * `gh` CLI. Five read tools (status, diff, log, current-branch, pr-info)
 * plus eight write tools (commit, pr-upsert, pr-comment, pr-review,
 * issue-comment, issue-create, discussion-create, discussion-comment). The
 * write tools run the same two-stage human-in-the-loop gate as
 * pi-slack-me and pi-asana: a HEADLESS guard (no UI -> refused unless the
 * explicit headless opt-in is set) and a REVIEW gate (an editable preview
 * dialog before anything reaches git or GitHub).
 *
 * The agent drafts the prose (commit message, PR title/body, issue
 * title/body, comment text); the user always sees it, can edit it, and can
 * cancel. Nothing commits, opens a PR or issue, starts a discussion, or
 * posts any comment until the user accepts.
 *
 * Based on: pi-slack-me / pi-asana confirm gate and house style.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { statusTool } from "../lib/tools/status";
import { diffTool } from "../lib/tools/diff";
import { logTool } from "../lib/tools/log";
import { currentBranchTool } from "../lib/tools/current-branch";
import { prInfoTool } from "../lib/tools/pr-info";
import { commitTool } from "../lib/tools/commit";
import { prUpsertTool } from "../lib/tools/pr-upsert";
import { prCommentTool } from "../lib/tools/pr-comment";
import { issueCommentTool } from "../lib/tools/issue-comment";
import { issueCreateTool } from "../lib/tools/issue-create";
import { discussionCreateTool } from "../lib/tools/discussion-create";
import { discussionCommentTool } from "../lib/tools/discussion-comment";
import { prReviewTool } from "../lib/tools/pr-review";
import { hasGh, isGitRepo } from "../lib/auth";
import {
  CONFIRM_WRITE_FLAG,
  CONFIRM_WRITE_FLAG_DESCRIPTION,
  ALLOW_HEADLESS_WRITE_FLAG,
  ALLOW_HEADLESS_WRITE_FLAG_DESCRIPTION,
  getConfirmWriteEnabled,
  setConfirmWriteEnabled,
  getAllowHeadlessWriteEnabled,
  setAllowHeadlessWriteEnabled,
} from "../lib/confirm";

// Compact tool guidance appended to the system prompt. The first sentence is
// the canonical rule: any text the agent intends to post as the user into
// GitHub MUST go through one of the git-me write tools (they drive `git` for
// the commit-message tool and `gh` for everything else). The agent MUST NOT
// fabricate the text and run `git`/`gh` itself; the editable preview is the
// whole point of the extension. Other git providers are explicitly out of
// scope — the user wires those up via their preferred path.
const TOOL_GUIDANCE = [
  "## git-me: git + GitHub write policy (binding)",
  "",
  "- CANONICAL RULE: any text the agent intends to record or post AS THE USER into git or GitHub — commit messages, PR titles/bodies, PR conversation comments, PR review bodies, issue comments, new issues, discussions and discussion comments — MUST go through one of the git-me write tools (they drive `git` and the `gh` CLI). Bypassing the editable preview is a policy violation.",
  "- The editable preview dialog IS the asking and IS the approval: the user reads your draft there, edits it, and presses Enter to accept or Esc to cancel. Therefore DRAFTING IS YOUR JOB. Do NOT ask the user in chat what the wording should be, do NOT paste a draft into chat asking 'shall I post this?', and do NOT ask for approval before calling the tool. Asking in chat duplicates the dialog.",
  "- Do NOT run `git` or `gh` through the bash/shell/terminal tool to post anything as the user. Forbidden via shell: `git commit`, `git commit --amend`, `gh pr create`, `gh pr edit`, `gh pr comment`, `gh pr review`, `gh issue comment`, `gh issue create`, and write-shaped `gh api` calls (GraphQL mutations, or REST POST/PATCH/DELETE — e.g. anything that creates a discussion or posts a discussion comment). Read-only shell inspection (`git show`, `gh pr view`, `gh api` GET queries, `gh issue list`) is permitted when no git-me read tool fits, but the git-me read tools are preferred.",
  "- If a write tool returns 'cancelled by user', the user pressed Esc. Do NOT retry through the shell and do NOT ask the user to paste the wording in chat. Ask the user whether to revise the draft or cancel the task; if they want to revise, call the same tool again with a revised draft.",
  "- Surface -> tool map: commit -> git_commit (`git commit -F -`); PR title + body, create or edit -> git_pr_upsert (`gh pr create` / `gh pr edit`); top-level PR conversation comment -> git_pr_comment (`gh pr comment`); PR review event (COMMENT / APPROVE / REQUEST_CHANGES) -> git_pr_review (`gh pr review`); issue comment -> git_issue_comment (`gh issue comment`); new issue -> git_issue_create (`gh issue create`); new discussion -> git_discussion_create (createDiscussion GraphQL mutation); discussion comment or threaded discussion reply -> git_discussion_comment (addDiscussionComment mutation).",
  "- Reach for git_status / git_diff / git_log / git_current_branch / git_pr_info BEFORE drafting any of the above, so the draft is grounded in the actual diff and PR state instead of invented.",
  "- git_commit applies via `git commit -F -` and normally requires staged changes (use git_diff target=staged to inspect). Exception: a merge in progress (MERGE_HEAD exists) commits with nothing staged; the commit itself records the merge, including zero-delta ancestry-marker merges.",
  "- git_pr_upsert creates a new PR via `gh pr create` when the branch has no PR, or edits the existing one via `gh pr edit` when it does; title and body are edited in one dialog.",
  "- git_pr_comment posts a plain PR conversation comment via `gh pr comment` without touching the PR review state (use git_pr_review for stateful review events).",
  "- git_pr_review posts via `gh pr review --comment` (or --approve / --request-changes). APPROVE / REQUEST_CHANGES change the PR review state and are always confirmed interactively even when the review gate is off. It posts a review SUMMARY body only — it cannot post inline line-level diff comments.",
  "- git_issue_comment posts via `gh issue comment <number> --body`; the issue number is required. Issue comments are flat — this same tool is the reply path for issues.",
  "- git_issue_create opens a new issue via `gh issue create` with title + body (and optional labels / assignees, `@me` allowed); title and body are edited in one dialog.",
  "- git_discussion_create starts a discussion via the createDiscussion GraphQL mutation (`gh api graphql`). There is NO `gh discussion` CLI command. The category NAME is required; a wrong name returns the repo's valid category names, so a first call is a safe way to discover them.",
  "- git_discussion_comment posts a comment on a discussion via the addDiscussionComment mutation, or a threaded REPLY under a specific comment when replyTo carries that comment's id (numeric REST id or GraphQL node id, discoverable read-only via `gh api repos/<owner>/<repo>/discussions/<n>/comments`). Discussions only — for issues use git_issue_comment.",
  "- Scope: this extension drives `git` (local, host-agnostic) and `gh` (GitHub only). Other providers — GitLab (glab), Gitea / Forgejo (tea), Bitbucket, direct REST, MCP servers — are NOT covered; the user wires those up themselves if needed.",
  "- In HEADLESS mode (no interactive UI), the write tools are REFUSED by default — an unsupervised run cannot commit, open a PR or issue, start a discussion, or post comments/reviews on the user's behalf. The git-allow-headless-write flag opts in to headless writes.",
].join("\n");

function gitMe(pi: ExtensionAPI): void {
  // NOTE: these toggles are deliberately NOT registered as pi flags. pi
  // extension flags are in-memory-only: registerFlag seeds the registered
  // default into the flag store, and getFlag cannot tell a CLI
  // `--git-confirm-write=false` from that seeded default. So a flag could not
  // durably reflect a /git config toggle (no setFlag), and a /settings row or
  // CLI flag would silently disagree with the on-disk state the gate actually
  // reads. Registering a control that does not work is worse than none. The
  // authoritative surface is the file-backed state in lib/confirm.ts, toggled
  // via /git config, /git confirm on|off, and /git headless on|off, and shown
  // by the /git status line and the /git config modal.

  pi.registerTool(statusTool);
  pi.registerTool(diffTool);
  pi.registerTool(logTool);
  pi.registerTool(currentBranchTool);
  pi.registerTool(prInfoTool);
  pi.registerTool(commitTool);
  pi.registerTool(prUpsertTool);
  pi.registerTool(prCommentTool);
  pi.registerTool(prReviewTool);
  pi.registerTool(issueCommentTool);
  pi.registerTool(issueCreateTool);
  pi.registerTool(discussionCreateTool);
  pi.registerTool(discussionCommentTool);

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: [event.systemPrompt, TOOL_GUIDANCE]
        .filter(Boolean)
        .join("\n\n"),
    };
  });

  // /git <verb> - prefix the editor with an explicit instruction so the agent
  // reaches for the right tool deterministically. The command cannot directly
  // dispatch a tool call, so it sets the editor text and the user hits Enter
  // to run. Same prefill pattern as pi-slack-me and pi-asana.
  //
  //   /git                       -> bare, prints usage + env status
  //   /git status                -> git_status
  //   /git diff [target]         -> git_diff (target: staged|unstaged|all|branch)
  //   /git log [N]               -> git_log
  //   /git branch                -> git_current_branch
  //   /git pr                    -> git_pr_info
  //   /git commit <subj>         -> git_commit with the suggested subject
  //   /git pr-create <title>     -> git_pr_upsert with the suggested title
  //   /git pr-comment [num]      -> git_pr_comment (top-level PR conversation comment)
  //   /git review                -> git_pr_review (PR review event)
  //   /git issue-comment <num>   -> git_issue_comment (issue comment)
  //   /git issue-create <title>  -> git_issue_create (new issue)
  //   /git discussion-create <title> -> git_discussion_create (new discussion)
  //   /git discussion-comment <num> -> git_discussion_comment (discussion comment/reply)
  //   /git config                -> settings modal (write review gate)
  //   /git confirm on|off        -> toggle write review gate
  //   /git headless on|off       -> toggle headless (no-UI) write opt-in
  pi.registerCommand("git", {
    description:
      'Git + GitHub (via gh) tools (act as you). Usage: /git status | /git diff [target] | /git log [N] | /git branch | /git pr | /git commit <subject> | /git pr-create <title> | /git pr-comment [num] | /git review | /git issue-comment <num> | /git issue-create <title> | /git discussion-create <title> | /git discussion-comment <num> | /git config | /git confirm on|off | /git headless on|off.',
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        const gh = hasGh() ? "gh CLI: ready" : "gh CLI: not found (GitHub tools will fail)";
        const confirm = getConfirmWriteEnabled() ? "on" : "off";
        const headless = getAllowHeadlessWriteEnabled() ? "on" : "off";
        ctx.ui.notify(
          `git-me: ready. Repo: yes. ${gh}. Write review: ${confirm} (toggle: /git confirm on|off). Headless writes: ${headless} (toggle: /git headless on|off). Verbs: status, diff, log, branch, pr, commit, pr-create, pr-comment, review, issue-comment, issue-create, discussion-create, discussion-comment, config.`,
          "info",
        );
        return;
      }

      const firstSpace = trimmed.indexOf(" ");
      const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

      // Only the git-touching verbs need a repo. config / confirm / headless
      // and the bare status line work anywhere, so the repo guard is scoped to
      // the verbs that actually run git or gh (previously it blocked /git
      // config outside a repo, which touches no git state).
      const REPO_VERBS = new Set([
        "status", "diff", "log", "branch", "pr",
        "commit", "pr-create", "pr-comment", "review", "issue-comment",
        "issue-create", "discussion-create", "discussion-comment",
      ]);
      if (REPO_VERBS.has(verb) && !isGitRepo(ctx.cwd)) {
        ctx.ui.notify(
          "git-me: cwd is not inside a git repository. Run pi from inside a repo, or use /git config | confirm | headless to manage settings.",
          "warning",
        );
        return;
      }

      let prompt: string | null = null;

      switch (verb) {
        case "status":
          prompt = `Call the git_status tool to show the working tree + branch status.`;
          break;
        case "diff":
          if (rest && ["staged", "unstaged", "all", "branch"].includes(rest)) {
            prompt = `Call the git_diff tool with target="${rest}" to show the diff for that target.`;
          } else if (!rest) {
            prompt = `Call the git_diff tool (default target="unstaged") to show the working tree diff.`;
          } else {
            ctx.ui.notify(
              `Unknown diff target "${rest}". Use one of: staged, unstaged, all, branch.`,
              "warning",
            );
            return;
          }
          break;
        case "log":
          if (rest && /^\d+$/.test(rest)) {
            prompt = `Call the git_log tool with limit=${rest} to show the last ${rest} commits.`;
          } else if (!rest) {
            prompt = `Call the git_log tool (default limit=10) to show the last 10 commits.`;
          } else {
            ctx.ui.notify(
              `Usage: /git log [N]   (N must be a positive integer)`,
              "warning",
            );
            return;
          }
          break;
        case "branch":
          prompt = `Call the git_current_branch tool to show the current branch name.`;
          break;
        case "pr":
          prompt = `Call the git_pr_info tool to show the PR for the current branch (or report that there is none).`;
          break;
        case "commit": {
          if (!rest) {
            ctx.ui.notify(
              "Usage: /git commit <suggested subject>\nExample: /git commit feat(api): add login endpoint",
              "warning",
            );
            return;
          }
          prompt = `Draft a Conventional Commits commit message for the current staged diff (use git_diff target=staged and git_log to match house style), then call the git_commit tool with subject=<your subject> and body=<your body>. The user will review the message in an editable dialog before it is applied.`;
          break;
        }
        case "pr-create": {
          if (!rest) {
            ctx.ui.notify(
              "Usage: /git pr-create <suggested title>\nExample: /git pr-create feat(api): add login endpoint",
              "warning",
            );
            return;
          }
          prompt = `Draft a PR title and body for the current branch (use git_current_branch, git_diff target=branch, and git_log to ground the suggestion), then call the git_pr_upsert tool with title=<your title> and body=<your body>. The user will review them in an editable dialog before they reach gh.`;
          break;
        }
        case "review":
          prompt = `Use git_pr_info to find the PR for the current branch, then draft a review comment grounded in the PR's diff and discussion, then call the git_pr_review tool with body=<your body>. The user will review the body in an editable dialog before it is posted.`;
          break;
        case "pr-comment": {
          const numMatch = rest && /^\d+$/.test(rest) ? ` number=${rest}` : "";
          prompt = `Use git_pr_info to find the PR for the current branch, draft a top-level conversation comment${numMatch ? ` for PR #${rest}` : ""}, then call the git_pr_comment tool with body=<your body>${numMatch}. The user will review the body in an editable dialog before it is posted. This is the canonical path for any plain PR conversation comment; do NOT fabricate and run \`gh pr comment\` yourself.`;
          break;
        }
        case "issue-comment": {
          if (!rest || !/^\d+$/.test(rest)) {
            ctx.ui.notify(
              "Usage: /git issue-comment <issue number>\nExample: /git issue-comment 123",
              "warning",
            );
            return;
          }
          prompt = `Draft a comment for issue #${rest}, then call the git_issue_comment tool with number=${rest} and body=<your body>. The user will review the body in an editable dialog before it is posted. This is the canonical path for any GitHub issue comment; do NOT fabricate and run \`gh issue comment\` yourself.`;
          break;
        }
        case "issue-create": {
          if (!rest) {
            ctx.ui.notify(
              "Usage: /git issue-create <suggested title>\nExample: /git issue-create feat(api): add login endpoint",
              "warning",
            );
            return;
          }
          prompt = `Draft a GitHub issue title and body for this task (ground them in real repo state with git_log / git_diff where it describes code), then call the git_issue_create tool with title=<your title> and body=<your body> (plus labels/assignees only if the user asked for them). The user will review title + body in an editable dialog before the issue is created. This is the canonical path for opening an issue; do NOT fabricate and run \`gh issue create\` yourself.`;
          break;
        }
        case "discussion-create": {
          if (!rest) {
            ctx.ui.notify(
              "Usage: /git discussion-create <suggested title>\nExample: /git discussion-create Roadmap feedback for Q4",
              "warning",
            );
            return;
          }
          prompt = `Draft a GitHub Discussion title and body for this task, then call the git_discussion_create tool with title=<your title>, body=<your body>, and category=<category name>. If you do not know the repo's discussion categories, call the tool with your best-guess category: a wrong name returns the valid names in the error. The user will review title + body in an editable dialog before the discussion is created. There is no \`gh discussion\` CLI command; this tool is the only path.`;
          break;
        }
        case "discussion-comment": {
          if (!rest || !/^\d+$/.test(rest)) {
            ctx.ui.notify(
              "Usage: /git discussion-comment <discussion number>\nExample: /git discussion-comment 42",
              "warning",
            );
            return;
          }
          prompt = `Draft a comment for discussion #${rest} (or a threaded reply by adding replyTo=<comment id>), then call the git_discussion_comment tool with number=${rest} and body=<your body>. The user will review the body in an editable dialog before it is posted. This is the canonical path for discussion replies; do NOT run \`gh api graphql\` mutations yourself.`;
          break;
        }
        case "config": {
          await openConfigModal(ctx);
          return;
        }
        case "confirm": {
          const next = rest.toLowerCase();
          if (next !== "on" && next !== "off") {
            ctx.ui.notify("Usage: /git confirm on|off", "warning");
            return;
          }
          const value = next === "on";
          if (setConfirmWriteEnabled(value)) {
            ctx.ui.notify(`${CONFIRM_WRITE_FLAG}: ${next}.`, "info");
          } else {
            ctx.ui.notify(`Failed to persist ${CONFIRM_WRITE_FLAG} (disk write failed).`, "error");
          }
          return;
        }
        case "headless": {
          const next = rest.toLowerCase();
          if (next !== "on" && next !== "off") {
            ctx.ui.notify("Usage: /git headless on|off", "warning");
            return;
          }
          const value = next === "on";
          if (setAllowHeadlessWriteEnabled(value)) {
            ctx.ui.notify(`${ALLOW_HEADLESS_WRITE_FLAG}: ${next}.`, "info");
          } else {
            ctx.ui.notify(`Failed to persist ${ALLOW_HEADLESS_WRITE_FLAG} (disk write failed).`, "error");
          }
          return;
        }
        default:
          ctx.ui.notify(
            `Unknown /git verb "${verb}". Verbs: status, diff, log, branch, pr, commit, pr-create, pr-comment, review, issue-comment, issue-create, discussion-create, discussion-comment, config, confirm, headless.`,
            "warning",
          );
          return;
      }

      if (prompt) ctx.ui.setEditorText(prompt);
    },
  });
}

// Settings modal for /git config. Two flags today; the SettingsList path
// scales if more flags are added later. Non-TUI callers get a status notify.
// Ported from pi-asana's openConfigModal; the gate is file-backed so no reload
// is needed after a toggle.
async function openConfigModal(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const currentConfirm = getConfirmWriteEnabled();
  const currentHeadless = getAllowHeadlessWriteEnabled();

  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      `git-me write review (the five write tools): ${currentConfirm ? "on" : "off"}. Headless writes: ${currentHeadless ? "on" : "off"}. Toggle: /git confirm on|off, /git headless on|off`,
      "info",
    );
    return;
  }

  const items: SettingItem[] = [
    {
      id: CONFIRM_WRITE_FLAG,
      label: "Review before git/gh writes",
      description: CONFIRM_WRITE_FLAG_DESCRIPTION,
      currentValue: currentConfirm ? "on" : "off",
      values: ["on", "off"],
    },
    {
      id: ALLOW_HEADLESS_WRITE_FLAG,
      label: "Allow writes in headless mode",
      description: ALLOW_HEADLESS_WRITE_FLAG_DESCRIPTION,
      currentValue: currentHeadless ? "on" : "off",
      values: ["on", "off"],
    },
  ];

  const pending = new Map<string, boolean>();

  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold("git-me extension settings")), 1, 1),
    );
    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id: string, newValue: string) => {
        pending.set(id, newValue === "on");
      },
      () => done(undefined),
    );
    container.addChild(settingsList);
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  // Persist genuine deltas only (drop net-zero flips). The generic onChange
  // key is the flag id, so this scales to any number of flags without a
  // per-flag persist block. File-backed setters apply live; no reload needed.
  const setters: Record<string, (v: boolean) => boolean> = {
    [CONFIRM_WRITE_FLAG]: setConfirmWriteEnabled,
    [ALLOW_HEADLESS_WRITE_FLAG]: setAllowHeadlessWriteEnabled,
  };
  const previous: Record<string, boolean> = {
    [CONFIRM_WRITE_FLAG]: currentConfirm,
    [ALLOW_HEADLESS_WRITE_FLAG]: currentHeadless,
  };
  let changed = false;
  for (const [id, target] of pending) {
    if (target === undefined || target === previous[id]) continue;
    const ok = setters[id]?.(target);
    if (ok) {
      ctx.ui.notify(`${id}: ${previous[id]} → ${target ? "on" : "off"}.`, "info");
      changed = true;
    } else {
      ctx.ui.notify(`Failed to persist ${id} (disk write failed).`, "error");
      changed = true;
    }
  }
  if (!changed) return;
}

export default gitMe;
