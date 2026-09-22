import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runGh, requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { describeReviewPayload, repoContextLabel } from "../format";
import { ghPrForCurrentBranch } from "../git";
import { toToolResult, errorText, postedContentExtras, type GitDetails } from "../result";
import {
  PR_REVIEW_TITLE,
  PR_REVIEW_DESCRIPTION,
  PR_REVIEW_BODY_DESCRIPTION,
  PR_REVIEW_PR_DESCRIPTION,
  PR_REVIEW_EVENT_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

// Post a PR review comment as YOU. The agent supplies the review body; this
// tool runs the two-stage human gate (headless guard + editable preview) and
// then applies via `gh pr review --comment --body`. APPROVE and
// REQUEST_CHANGES are also supported but they change the PR review state, so
// the agent should reach for COMMENT when the goal is only to leave feedback.
//
// `pr` defaults to the PR for the current branch. When the branch has no PR,
// the tool fails closed with a readable message - the user should run
// /git pr first to open one.

const Params = Type.Object({
  body: Type.String({ description: PR_REVIEW_BODY_DESCRIPTION, minLength: 1 }),
  pr: Type.Optional(
    Type.Integer({
      description: PR_REVIEW_PR_DESCRIPTION,
      minimum: 1,
    }),
  ),
  event: Type.Optional(
    Type.String({
      description: PR_REVIEW_EVENT_DESCRIPTION,
      enum: ["COMMENT", "APPROVE", "REQUEST_CHANGES"],
    }),
  ),
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const satisfies readonly ReviewEvent[];

// Narrow the TypeBox `enum` constraint (which TS sees as plain string) to
// the literal union. Unknown / undefined -> "COMMENT".
export function parseReviewEvent(raw: string | undefined): ReviewEvent {
  return (REVIEW_EVENTS as readonly string[]).includes(raw ?? "")
    ? (raw as ReviewEvent)
    : "COMMENT";
}

export const prReviewTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_pr_review",
  label: PR_REVIEW_TITLE,
  description: PR_REVIEW_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<GitDetails>> {
    const cwd = params.cwd ?? ctx.cwd;
    try {
      requireGitRepo(cwd);
      requireGh();
    } catch (err) {
      if (err instanceof GitMeEnvError) return toToolResult(err.message);
      throw err;
    }

    const event = parseReviewEvent(params.event);

    // Resolve PR number: explicit > current-branch PR > fail closed.
    let prNumber = params.pr;
    if (prNumber === undefined) {
      const current = ghPrForCurrentBranch(cwd);
      if (current === null) {
        return toToolResult(
          "git-me: no PR found for the current branch. Pass `pr` explicitly or open a PR first (git_pr_upsert with create).",
        );
      }
      prNumber = current.number;
    }

    const eventLabel =
      (event === "APPROVE"
        ? "Approve this PR with this body?"
        : event === "REQUEST_CHANGES"
          ? "Request changes on this PR with this body?"
          : "Post this review comment on this PR?") + repoContextLabel(cwd, ctx.cwd);

    const decision = await confirmWrite(ctx, {
      title: eventLabel,
      editableText: params.body,
      summary: describeReviewPayload(params.body),
      // The applied body is trimEnd()'d before it reaches gh.
      normalize: (s) => s.trimEnd(),
      // APPROVE / REQUEST_CHANGES are public, stateful, and hard to reverse:
      // force the gate even when git-confirm-write is off, and block them
      // unconditionally in headless mode (the headless opt-in does NOT apply).
      requireInteractive: event !== "COMMENT",
    });
    if (!decision.proceed) {
      return toToolResult(
        ctx.hasUI
          ? `git-me: review ${event.toLowerCase()} cancelled by user. Nothing was sent to gh.`
          : event === "COMMENT"
            ? `git-me: review comment not posted (headless mode; no UI to review). Use /git headless on to allow unsupervised review posts.`
            : `git-me: ${event.toLowerCase()} is a stateful review event and cannot run in headless mode (it changes the PR review state). Run it from an interactive session.`,
      );
    }

    const body = (decision.text ?? params.body).trimEnd();
    if (!body) {
      return toToolResult(
        "git-me: review body is empty after edit; nothing was posted.",
      );
    }

    try {
      // Map event -> gh flag. COMMENT is the default review (no --approve /
      // --request-changes), and just needs --body.
      const args =
        event === "APPROVE"
          ? ["pr", "review", String(prNumber), "--approve", "--body", body]
          : event === "REQUEST_CHANGES"
            ? ["pr", "review", String(prNumber), "--request-changes", "--body", body]
            : ["pr", "review", String(prNumber), "--comment", "--body", body];

      const result = runGh(args, cwd);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return toToolResult(
          `git-me: \`gh pr review\` failed (exit ${result.exitCode}). ${detail}`,
        );
      }

      const verb =
        event === "APPROVE"
          ? "Approved"
          : event === "REQUEST_CHANGES"
            ? "Requested changes on"
            : "Posted review comment on";
      const { extraText, details } = postedContentExtras(body, decision.edited ?? false);
      return toToolResult(`${verb} PR #${prNumber}.${extraText}`, details);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
