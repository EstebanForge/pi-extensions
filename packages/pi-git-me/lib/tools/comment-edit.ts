// Edit an existing comment written by the authenticated user, on an issue or
// a PR conversation. One shared implementation, two registered tools:
//
//   git_issue_comment_edit -> lib factory kind="issue"
//   git_pr_comment_edit    -> lib factory kind="pr"
//
// GitHub models PR conversation comments as issue comments, so ONE REST
// resource serves both surfaces:
//   GET  /repos/{o}/{r}/issues/{n}/comments      (list, --paginate)
//   GET  /repos/{o}/{r}/issues/comments/{id}     (single, explicit-id path)
//   PATCH /repos/{o}/{r}/issues/comments/{id}    (apply)
//
// Self-authorship rule: the tool only edits comments authored by the
// authenticated user (the same constraint gh's own `--edit-last` carries).
// A comment by anyone else is refused, never edited.
//
// Target resolution: the user's LAST comment on the thread by default, or an
// explicit `commentId` REST id for an older one. There is deliberately no
// create-if-none fallback: this tool EDITS; posting new comments stays with
// git_issue_comment / git_pr_comment.
//
// Gate order follows the house pattern: environment guards -> target lookup
// (read-only, so the review dialog can refuse on a missing target) -> no-op
// guard (identical body: nothing is sent, no dialog) -> editable preview of
// the NEW body -> PATCH only after the user accepts.

import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runGh, requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { describeReviewPayload, repoContextLabel } from "../format";
import { ghPrForCurrentBranch } from "../git";
import type { GhPullRequest } from "../types";
import { ghRepoView } from "../github";
import { toToolResult, errorText, postedContentExtras, type GitDetails } from "../result";
import {
  COMMENT_EDIT_BODY_DESCRIPTION,
  COMMENT_EDIT_COMMENT_ID_DESCRIPTION,
  COMMENT_EDIT_CWD_DESCRIPTION,
  ISSUE_COMMENT_EDIT_TITLE,
  ISSUE_COMMENT_EDIT_DESCRIPTION,
  ISSUE_COMMENT_EDIT_NUMBER_DESCRIPTION,
  PR_COMMENT_EDIT_TITLE,
  PR_COMMENT_EDIT_DESCRIPTION,
  PR_COMMENT_EDIT_NUMBER_DESCRIPTION,
} from "../prompts";

/** The comment fields this tool reads from the REST payloads. */
interface GhComment {
  id?: unknown;
  body?: unknown;
  html_url?: unknown;
  issue_url?: unknown;
  user?: { login?: unknown } | null;
}

/** Thread number from a comment's issue_url (".../issues/42" -> 42). undefined when absent or malformed. */
function threadNumberFromIssueUrl(issueUrl: unknown): number | undefined {
  if (typeof issueUrl !== "string") return undefined;
  const m = issueUrl.match(/\/issues\/(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

function parseComment(raw: string): GhComment | null {
  try {
    return JSON.parse(raw) as GhComment;
  } catch {
    return null;
  }
}

/** Authenticated login (`gh api user --jq .login`). null when gh fails. */
function authedLogin(cwd: string): string | null {
  const result = runGh(["api", "user", "--jq", ".login"], cwd);
  if (result.exitCode !== 0) return null;
  const login = result.stdout.trim();
  return login ? login : null;
}

/**
 * The authenticated user's LAST comment on issue/PR `number`. Issue and PR
 * conversation comments share the same REST listing. `--paginate` walks all
 * pages and `--jq '.[] | @json'` emits one single-line JSON object per
 * comment (newlines inside bodies arrive escaped, so line-splitting is safe).
 * Returns null when gh fails or the user has no comment there.
 */
function lastOwnComment(
  nameWithOwner: string,
  number: number,
  login: string,
  cwd: string,
): GhComment | null {
  const result = runGh(
    [
      "api",
      `repos/${nameWithOwner}/issues/${number}/comments?per_page=100`,
      "--paginate",
      "--jq",
      ".[] | @json",
    ],
    cwd,
  );
  if (result.exitCode !== 0) return null;
  let last: GhComment | null = null;
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const comment = parseComment(trimmed);
    if (!comment) continue;
    if (
      typeof comment.user?.login !== "string" ||
      comment.user.login.toLowerCase() !== login.toLowerCase()
    )
      continue;
    last = comment;
  }
  return last;
}

/** One comment by REST id. null when gh fails (bad id, no access). */
function commentById(nameWithOwner: string, id: number, cwd: string): GhComment | null {
  const result = runGh(
    ["api", `repos/${nameWithOwner}/issues/comments/${id}`],
    cwd,
  );
  if (result.exitCode !== 0) return null;
  return parseComment(result.stdout);
}

export interface CommentEditKindConfig {
  kind: "issue" | "pr";
  name: string;
  label: string;
  description: string;
  /** Schema fragment for the thread number: required (issue) vs optional (PR). */
  numberParam:
    | { required: true; description: string }
    | { required: false; description: string };
  /** Noun pair used in fail-closed messages, e.g. "git_issue_comment". */
  postToolName: string;
}

export function buildCommentEditTool(
  cfg: CommentEditKindConfig,
): ToolDefinition<Record<string, unknown>, GitDetails> {
  // Thread-number param name follows the sister tools: `number` on the issue
  // flavor (git_issue_comment uses `number`), `pr` on the PR flavor
  // (git_pr_comment / git_pr_review use `pr`). The fail-closed messages and
  // the /git prefill prompts reference the same name, so the model never
  // passes a param the schema silently ignores.
  const threadNumberSchema = () =>
    Type.Integer({ description: cfg.numberParam.description, minimum: 1 });
  const Params = Type.Object({
    body: Type.String({ description: COMMENT_EDIT_BODY_DESCRIPTION, minLength: 1 }),
    ...(cfg.numberParam.required
      ? { number: threadNumberSchema() }
      : { pr: Type.Optional(threadNumberSchema()) }),
    commentId: Type.Optional(
      Type.Integer({ description: COMMENT_EDIT_COMMENT_ID_DESCRIPTION, minimum: 1 }),
    ),
    cwd: Type.Optional(Type.String({ description: COMMENT_EDIT_CWD_DESCRIPTION })),
  });

  /** Shape the execute body reads (mirrors the conditional Params above). */
  interface CommentEditParams {
    body: string;
    number?: number;
    pr?: number;
    commentId?: number;
    cwd?: string;
  }

  const kindNoun = cfg.kind === "issue" ? "issue" : "PR";

  return {
    name: cfg.name,
    label: cfg.label,
    description: cfg.description,
    parameters: Params as unknown as ToolDefinition<Record<string, unknown>, GitDetails>["parameters"],
    async execute(
      _toolCallId: string,
      params: Static<typeof Params>,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<GitDetails>> {
      const p = params as unknown as CommentEditParams;
      const cwd = p.cwd ?? ctx.cwd;
      try {
        requireGitRepo(cwd);
        requireGh();
      } catch (err) {
        if (err instanceof GitMeEnvError) return toToolResult(err.message);
        throw err;
      }

      const repo = ghRepoView(cwd);
      if (!repo) {
        return toToolResult(
          `git-me: could not resolve a GitHub repository for "${cwd}" (\`gh repo view\` failed). Nothing was edited.`,
        );
      }

      // Resolve WHICH comment: an explicit commentId stands on its own
      // (comment ids are repo-scoped REST ids and need no thread number), so
      // a PR-flavor edit with commentId also works from a branch with no PR.
      // The last-comment lookup needs the thread number: the PR flavor falls
      // back to the current-branch PR (same fail-closed contract as
      // git_pr_comment), the issue flavor carries a required `number`.
      const login = authedLogin(cwd);
      if (!login) {
        return toToolResult(
          "git-me: could not resolve your GitHub login (`gh api user` failed). Nothing was edited.",
        );
      }
      let target: GhComment | null;
      let number: number | undefined = cfg.kind === "issue" ? p.number : p.pr;
      let resolvedPr: GhPullRequest | null = null;
      if (p.commentId !== undefined) {
        target = commentById(repo.nameWithOwner, p.commentId, cwd);
        if (!target || typeof target.id !== "number") {
          return toToolResult(
            `git-me: comment ${String(p.commentId)} not found in ${repo.nameWithOwner} (\`gh api\` lookup failed). Nothing was edited.`,
          );
        }
        if (number === undefined) {
          number = threadNumberFromIssueUrl(target.issue_url);
        }
      } else {
        if (number === undefined && cfg.kind === "pr") {
          resolvedPr = ghPrForCurrentBranch(cwd);
          if (resolvedPr === null) {
            return toToolResult(
              "git-me: no PR found for the current branch. Pass `pr` explicitly or open a PR first (git_pr_upsert with create).",
            );
          }
          number = resolvedPr.number;
        }
        if (number === undefined) {
          return toToolResult(`git-me: a ${kindNoun} number is required.`);
        }
        target = lastOwnComment(repo.nameWithOwner, number, login, cwd);
        if (!target || typeof target.id !== "number") {
          return toToolResult(
            `git-me: no comment by @${login} found on ${kindNoun} #${String(number)} in ${repo.nameWithOwner}. This tool edits YOUR comments only; post one first with ${cfg.postToolName}.`,
          );
        }
      }
      // GitHub logins are case-insensitive; compare that way so a differently
      // cased display login can never reject the user's own comment.
      if (
        typeof target.user?.login !== "string" ||
        target.user.login.toLowerCase() !== login.toLowerCase()
      ) {
        return toToolResult(
          `git-me: comment ${String(target.id)} was authored by @${String(target.user?.login ?? "unknown")}, not by @${login}. git-me edits only your own comments.`,
        );
      }
      // commentId is repo-scoped: guard the thread boundary so a stated
      // number cannot pair with a commentId that lives on another thread.
      const issueUrl = typeof target.issue_url === "string" ? target.issue_url : "";
      if (number !== undefined && issueUrl && !issueUrl.endsWith(`/${String(number)}`)) {
        return toToolResult(
          `git-me: comment ${String(target.id)} belongs to ${issueUrl}, not ${kindNoun} #${String(number)}. Nothing was edited.`,
        );
      }
      const currentBody = typeof target.body === "string" ? target.body : "";

      // No-op guard before the gate: a body identical to the current one
      // would only bump the comment's updated_at, so skip dialog AND PATCH.
      const nextBody = p.body.trimEnd();
      if (nextBody === currentBody.trimEnd()) {
        return toToolResult(
          `git-me: the new body is identical to your existing comment${number !== undefined ? ` on ${kindNoun} #${String(number)}` : ""}; nothing was sent.`,
        );
      }

      const threadLabel =
        number !== undefined ? `your comment on ${kindNoun} #${String(number)}` : "your comment";
      const decision = await confirmWrite(ctx, {
        title: `Edit ${threadLabel}? (replaces the existing text)${repoContextLabel(cwd, ctx.cwd)}`,
        editableText: nextBody,
        summary: describeReviewPayload(nextBody),
        // Same normalization the no-op guard used, so a whitespace-only edit
        // that gets trimmed away does not count as "edited".
        normalize: (s) => s.trimEnd(),
      });
      if (!decision.proceed) {
        return toToolResult(
          ctx.hasUI
            ? `git-me: comment edit cancelled by user. Nothing was sent to gh.`
            : `git-me: comment edit not applied (headless mode; no UI to review). Use /git headless on to allow unsupervised edits.`,
        );
      }

      const body = (decision.text ?? nextBody).trimEnd();
      if (!body) {
        return toToolResult(
          "git-me: edited body is empty; an empty body would delete the comment. Nothing was sent (GitHub has no comment-erase via this API; delete by hand if that is the goal).",
        );
      }

      try {
        const result = runGh(
          [
            "api",
            "--method",
            "PATCH",
            `repos/${repo.nameWithOwner}/issues/comments/${String(target.id)}`,
            "-f",
            `body=${body}`,
          ],
          cwd,
        );
        if (result.exitCode !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim();
          return toToolResult(
            `git-me: \`gh api PATCH\` failed (exit ${result.exitCode}). ${detail}`,
          );
        }
        const updated = parseComment(result.stdout);
        const url =
          typeof updated?.html_url === "string" && updated.html_url
            ? updated.html_url
            : resolvedPr?.url;
        const urlLine = url ? `\n  url: ${url}` : "";
        const { extraText, details } = postedContentExtras(body, decision.edited ?? false);
        return toToolResult(
          `Edited your comment on ${kindNoun} #${number}.${urlLine}${extraText}`,
          details,
        );
      } catch (err) {
        return toToolResult(errorText(err));
      }
    },
  };
}

export const issueCommentEditTool = buildCommentEditTool({
  kind: "issue",
  name: "git_issue_comment_edit",
  label: ISSUE_COMMENT_EDIT_TITLE,
  description: ISSUE_COMMENT_EDIT_DESCRIPTION,
  numberParam: { required: true, description: ISSUE_COMMENT_EDIT_NUMBER_DESCRIPTION },
  postToolName: "git_issue_comment",
});

export const prCommentEditTool = buildCommentEditTool({
  kind: "pr",
  name: "git_pr_comment_edit",
  label: PR_COMMENT_EDIT_TITLE,
  description: PR_COMMENT_EDIT_DESCRIPTION,
  numberParam: { required: false, description: PR_COMMENT_EDIT_NUMBER_DESCRIPTION },
  postToolName: "git_pr_comment",
});
