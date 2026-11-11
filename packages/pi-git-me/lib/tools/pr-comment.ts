import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runGh, requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { describeReviewPayload, repoContextLabel, gateRepoSuffix } from "../format";
import { extractUrl } from "../git";
import { resolvePrForBranch, branchPrRefusal, ghPrByNumber, verifyPrTarget, prTargetLabel, branchLabel } from "../pr-target";
import type { GhPullRequest } from "../types";
import { ghRepoView } from "../github";
import { parseRepoParam, repoParamConflict } from "../repo-target";
import {
  validateAttachmentPaths,
  uploadAttachmentsForComment,
  appendAttachments,
  type UploadedAttachment,
} from "../attachment-upload";
import { toToolResult, errorText, postedContentExtras, type GitDetails } from "../result";
import {
  PR_COMMENT_TITLE,
  PR_COMMENT_DESCRIPTION,
  PR_COMMENT_BODY_DESCRIPTION,
  PR_COMMENT_NUMBER_DESCRIPTION,
  COMMENT_IMAGES_DESCRIPTION,
  REPO_PARAM_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

// Post a top-level conversation comment on a pull request (via
// `gh pr comment <number> --body`). This is distinct from `git_pr_review`,
// which posts a REVIEW event (COMMENT / APPROVE / REQUEST_CHANGES) on the
// PR's review summary: that updates the review state, this is just a normal
// comment on the PR conversation.
//
// The agent supplies the PR number and the comment body; this tool runs the
// two-stage human gate (headless guard + editable preview) and then applies.
//
// `pr` defaults to the PR for the current branch. When the branch has no PR,
// the tool fails closed with a readable message - the user should run
// /git pr first to open one.

const Params = Type.Object({
  body: Type.String({ description: PR_COMMENT_BODY_DESCRIPTION, minLength: 1 }),
  pr: Type.Optional(
    Type.Integer({
      description: PR_COMMENT_NUMBER_DESCRIPTION,
      minimum: 1,
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String({ description: COMMENT_IMAGES_DESCRIPTION })),
  ),
  repo: Type.Optional(Type.String({ description: REPO_PARAM_DESCRIPTION })),
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

export const prCommentTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_pr_comment",
  label: PR_COMMENT_TITLE,
  description: PR_COMMENT_DESCRIPTION,
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

    // Fail fast on bad attachment paths BEFORE any network call (snapshot
    // fetch included): stat + extension checks are local and cheap, and
    // reviewing a doomed comment wastes the user's attention.
    const imagePaths = params.images ?? [];
    if (imagePaths.length > 0) {
      const problems = await validateAttachmentPaths(imagePaths);
      if (problems.length > 0) {
        const prLabel = params.pr !== undefined ? `PR #${params.pr}` : "the current branch's PR";
        return toToolResult(
          `git-me: refused to post comment (${prLabel}) - attachment problem(s):\n- ${problems.join("\n- ")}`,
        );
      }
    }

    const targetRepo = repoInput.kind === "ok" ? repoInput.slug : ghRepoView(cwd)?.nameWithOwner ?? null;

    // Resolve the PR number and SNAPSHOT the target before the gate.
    //   - explicit `pr`: fetched by number (-R-addressed with a repo slug);
    //     not-found refuses before the gate instead of failing after approval.
    //   - omitted `pr`: branch-bound resolution binds only an OPEN PR whose
    //     headRefName equals the checked-out branch; closed/mismatched/
    //     ambiguous targets refuse with a pass-`pr`-explicitly message.
    // The snapshot's identity (number, state, head, base, repo) is what the
    // gate shows and what apply-time verification compares.
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
          `git-me: PR #${prNumber} not found in ${where} (\`gh pr view ${prNumber}\` failed). Nothing was posted; check the number.`,
        );
      }
      // The gate names the checked-out branch too (rule: full target
      // identity), even though the number is the binding.
      branch = repoInput.kind === "ok" ? null : branchLabel(cwd);
    }

    const decision = await confirmWrite(ctx, {
      title: `Post this comment on ${prTargetLabel(resolved, branch)}${gateRepoSuffix(targetRepo)}?${repoContextLabel(cwd, ctx.cwd)}`,
      editableText: params.body,
      summary:
        describeReviewPayload(params.body) +
        (imagePaths.length > 0
          ? `\n\n[attach: ${imagePaths.map((p) => p.split("/").pop()).join(", ")}]`
          : ""),
      // The applied body is trimEnd()'d before it reaches gh.
      normalize: (s) => s.trimEnd(),
    });
    if (!decision.proceed) {
      return toToolResult(
        ctx.hasUI
          ? `git-me: PR comment cancelled by user. Nothing was sent to gh.`
          : `git-me: PR comment not posted (headless mode; no UI to review). Use /git headless on to allow unsupervised comments.`,
      );
    }

    let body = (decision.text ?? params.body).trimEnd();
    if (!body) {
      return toToolResult(
        "git-me: PR comment body is empty after edit; nothing was posted.",
      );
    }

    // Apply-time target check BEFORE any upload or post: the human approved
    // the gate's identity, and a human can close/merge/retarget the PR while
    // the dialog is open. Any drift aborts with nothing sent.
    const verified = verifyPrTarget(resolved, cwd, repoInput.kind === "ok" ? repoInput.slug : undefined);
    if (!verified.ok) return toToolResult(verified.message);

    // Upload attachments AFTER the gate (cancel = zero side effects) and
    // BEFORE the gh post (a failed upload must not leave a comment whose body
    // references files that never landed). Repo resolution happens here too:
    // only the upload path needs it, and a null view must abort before any
    // upload starts.
    let uploaded: UploadedAttachment[] = [];
    if (imagePaths.length > 0) {
      if (!targetRepo) {
        return toToolResult(
          `git-me: cannot attach images - could not resolve a GitHub repository for "${cwd}" (\`gh repo view\` failed). Nothing was posted.`,
        );
      }
      try {
        uploaded = await uploadAttachmentsForComment({
          paths: imagePaths,
          nameWithOwner: targetRepo,
          cwd,
        });
      } catch (err) {
        return toToolResult(errorText(err));
      }
      body = appendAttachments(body, uploaded);
    }

    try {
      const args = ["pr", "comment", String(prNumber)];
      if (repoInput.kind === "ok") args.push("-R", repoInput.slug);
      args.push("--body", body);
      const result = runGh(args, cwd);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return toToolResult(
          `git-me: \`gh pr comment\` failed (exit ${result.exitCode}). ${detail}`,
        );
      }
      const attachPart = uploaded.length > 0 ? ` Attached ${uploaded.length} image(s).` : "";
      // gh prints the new comment URL on stdout; fall back to the PR url we
      // resolved earlier when stdout carries none.
      const url = extractUrl(result.stdout) ?? resolved?.url;
      const urlLine = url ? `\n  url: ${url}` : "";
      const { extraText, details } = postedContentExtras(body, decision.edited ?? false);
      return toToolResult(`Posted comment on PR #${prNumber}.${attachPart}${urlLine}${extraText}`, details);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
