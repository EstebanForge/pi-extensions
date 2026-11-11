import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runGh, requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { describeReviewPayload, repoContextLabel, gateRepoSuffix } from "../format";
import { resolvePrForBranch, branchPrRefusal, ghPrByNumber, verifyPrTarget, prTargetLabel, branchLabel } from "../pr-target";
import type { GhPullRequest } from "../types";
import { ghRepoView } from "../github";
import { parseRepoParam, repoParamConflict } from "../repo-target";
import { toToolResult, errorText, postedContentExtras, type GitDetails } from "../result";
import {
  PR_REVIEW_TITLE,
  PR_REVIEW_DESCRIPTION,
  PR_REVIEW_BODY_DESCRIPTION,
  PR_REVIEW_PR_DESCRIPTION,
  PR_REVIEW_EVENT_DESCRIPTION,
  REPO_PARAM_DESCRIPTION,
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
  repo: Type.Optional(Type.String({ description: REPO_PARAM_DESCRIPTION })),
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
    const conflict = repoParamConflict(params);
    if (conflict) return toToolResult(conflict);
    const repoInput = parseRepoParam(params.repo);
    try {
      if (repoInput.kind !== "ok") requireGitRepo(cwd);
      requireGh();
    } catch (err) {
      if (err instanceof GitMeEnvError) return toToolResult(err.message);
      throw err;
    }
    if (repoInput.kind === "ok" && params.pr === undefined) {
      return toToolResult(
        "git-me: a pr number is required when repo is set: a current-branch PR only resolves in your own checkout. Pass pr explicitly.",
      );
    }
    const targetRepo = repoInput.kind === "ok" ? repoInput.slug : ghRepoView(cwd)?.nameWithOwner ?? null;

    const event = parseReviewEvent(params.event);

    // Resolve the PR number and SNAPSHOT the target before the gate, same
    // contract as git_pr_comment: explicit `pr` is fetched by number
    // (not-found refuses before the gate); omitted `pr` binds only an OPEN
    // PR whose head equals the checked-out branch, everything else refuses
    // with a pass-`pr`-explicitly message. The snapshot is what the gate
    // shows and what apply-time verification compares.
    let prNumber = params.pr;
    let resolved: GhPullRequest | null = null;
    let branch: string | null = null;
    if (prNumber === undefined) {
      const res = resolvePrForBranch(cwd);
      const refusal = branchPrRefusal(res);
      if (refusal) return toToolResult(refusal);
      if (res.kind !== "ok") {
        return toToolResult(
          "git-me: no PR found for the current branch. Pass `pr` explicitly or open a PR first (git_pr_upsert with create).",
        );
      }
      resolved = res.pr;
      branch = res.branch;
      prNumber = resolved.number;
    } else {
      resolved = ghPrByNumber(prNumber, cwd, repoInput.kind === "ok" ? repoInput.slug : undefined);
      if (!resolved) {
        const where = repoInput.kind === "ok" ? repoInput.slug : "the current repository";
        return toToolResult(
          `git-me: PR #${prNumber} not found in ${where} (\`gh pr view ${prNumber}\` failed). Nothing was reviewed; check the number.`,
        );
      }
      // The gate names the checked-out branch too (rule: full target
      // identity), even though the number is the binding.
      branch = repoInput.kind === "ok" ? null : branchLabel(cwd);
    }

    const eventLabel =
      (event === "APPROVE"
        ? `Approve ${prTargetLabel(resolved, branch)}`
        : event === "REQUEST_CHANGES"
          ? `Request changes on ${prTargetLabel(resolved, branch)}`
          : `Post this review comment on ${prTargetLabel(resolved, branch)}`) + gateRepoSuffix(targetRepo) + "?" + repoContextLabel(cwd, ctx.cwd);

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

    // Apply-time target check BEFORE the review event: the human approved
    // the gate's identity, and a human can close/merge/retarget the PR while
    // the dialog is open. Any drift aborts with nothing sent.
    const verified = verifyPrTarget(resolved, cwd, repoInput.kind === "ok" ? repoInput.slug : undefined);
    if (!verified.ok) return toToolResult(verified.message);

    try {
      // Map event -> gh flag. COMMENT is the default review (no --approve /
      // --request-changes), and just needs --body. -R names the target repo
      // explicitly when the agent set one.
      const base = ["pr", "review", String(prNumber)];
      if (repoInput.kind === "ok") base.push("-R", repoInput.slug);
      const args =
        event === "APPROVE"
          ? [...base, "--approve", "--body", body]
          : event === "REQUEST_CHANGES"
            ? [...base, "--request-changes", "--body", body]
            : [...base, "--comment", "--body", body];

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
      // gh pr review prints nothing on success; the resolve-time snapshot
      // already carries the PR url for both resolution paths.
      const url = resolved?.url;
      const urlLine = url ? `\n  url: ${url}` : "";
      const { extraText, details } = postedContentExtras(body, decision.edited ?? false);
      return toToolResult(`${verb} PR #${prNumber}.${urlLine}${extraText}`, details);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
