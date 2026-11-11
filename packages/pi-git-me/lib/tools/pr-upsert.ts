import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runGh, requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { describeTitleBodyPayload, repoContextLabel, gateRepoSuffix, toTitleBodyPrefill, fromTitleBodyPrefill } from "../format";
import { ghRepoView } from "../github";
import { resolvePrForBranch, branchPrRefusal, verifyPrTarget, prTargetLabel, branchLabel } from "../pr-target";
import { toToolResult, errorText, postedContentExtras, type GitDetails } from "../result";
import {
  PR_UPSERT_TITLE,
  PR_UPSERT_DESCRIPTION,
  PR_UPSERT_TITLE_DESCRIPTION,
  PR_UPSERT_BODY_DESCRIPTION,
  PR_UPSERT_BASE_DESCRIPTION,
  PR_UPSERT_DRAFT_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

// Create or update the PR for the current branch. The agent supplies title
// and body; this tool runs the two-stage human gate (headless guard +
// editable preview) and then applies via `gh pr create` (when no PR exists)
// or `gh pr edit` (when one already exists).
//
// The title/body editor prefill (single buffer, "---" separator) and its
// split-back parser live in ../format: three write tools now share them
// (PR, issue, discussion creation).

const Params = Type.Object({
  title: Type.String({ description: PR_UPSERT_TITLE_DESCRIPTION, minLength: 1 }),
  body: Type.String({ description: PR_UPSERT_BODY_DESCRIPTION, minLength: 1 }),
  base: Type.Optional(Type.String({ description: PR_UPSERT_BASE_DESCRIPTION })),
  draft: Type.Optional(Type.Boolean({ description: PR_UPSERT_DRAFT_DESCRIPTION })),
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});



export const prUpsertTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_pr_upsert",
  label: PR_UPSERT_TITLE,
  description: PR_UPSERT_DESCRIPTION,
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

    // Resolve the target BEFORE the gate (requireGh above ruled out
    // gh-missing / gh-unauthed). Branch-bound resolution only ever binds an
    // OPEN PR whose headRefName equals the checked-out branch; anything else
    // refuses (mismatch/ambiguous/error) or falls through to CREATE
    // (none/closed). This lets the dialog tell the user whether they are
    // CREATING a new public PR or OVERWRITING an existing one - materially
    // different consequences that used to share one vague prompt.
    const resolution = resolvePrForBranch(cwd);
    // mismatch/ambiguous are hard refuses (gh state is confusing; creating
    // or editing blind could hit the wrong PR). error refuses because a gh
    // failure must not silently become a duplicate create. none and closed
    // fall through to CREATE below; a new PR from the branch is the intended
    // upsert.
    if (resolution.kind === "mismatch" || resolution.kind === "ambiguous" || resolution.kind === "error") {
      return toToolResult(branchPrRefusal(resolution)!);
    }
    // CLOSED or MERGED PRs are never edit targets: a new PR from the branch
    // is the intended upsert (gh allows it once the old one is closed).
    const existing = resolution.kind === "ok" ? resolution.pr : null;
    const branch = resolution.branch;
    const base = params.base ?? "main";
    // A PR is branch-bound (no repo param), but the dialog must still name
    // the repo it will open/edit the PR in.
    const targetRepo = ghRepoView(cwd)?.nameWithOwner ?? null;

    const prefill = toTitleBodyPrefill(params.title, params.body);
    const summary = describeTitleBodyPayload(params.title, params.body);

    const decision = await confirmWrite(ctx, {
      title:
        existing === null
          ? `Open a new PR${gateRepoSuffix(targetRepo)} (${base} <- HEAD${branch ? `, branch "${branch}"` : ""}) with this title + body?${repoContextLabel(cwd, ctx.cwd)}`
          : `Overwrite ${prTargetLabel(existing, branch)}${gateRepoSuffix(targetRepo)} title + body?${repoContextLabel(cwd, ctx.cwd)}`,
      editableText: prefill,
      summary,
      // gh receives the title and body as separate, trimmed fields. Mirror that
      // split+trim here so a whitespace-only edit inside either field does not
      // register as edited when the transmitted title/body are unchanged.
      normalize: (s) => {
        const r = fromTitleBodyPrefill(s, params.title);
        return `${r.title}\n${r.body}`;
      },
    });
    if (!decision.proceed) {
      return toToolResult(
        ctx.hasUI
          ? "git-me: PR description cancelled by user. Nothing was sent to gh."
          : "git-me: PR description not applied (headless mode; no UI to review). Use /git headless on to allow unsupervised PR edits.",
      );
    }

    const { title, body } = fromTitleBodyPrefill(decision.text ?? prefill, params.title);
    if (!title || !body) {
      return toToolResult(
        "git-me: PR title and body are both required. Edit left one empty; nothing was applied.",
      );
    }
    // Hoisted so both the CREATE and EDIT success returns can echo the title
    // + body that reached gh, but ONLY when the user changed the prefill
    // (otherwise the agent already has its own draft in context).
    const postedContent = `Title: ${title}\n\n${body}`;
    const { extraText, details } = postedContentExtras(postedContent, decision.edited ?? false);

    try {
      if (existing === null) {
        // CREATE branch. The branch-bound resolution named the checked-out
        // branch in the gate; if the human flipped branches while the dialog
        // was open, `gh pr create` would publish from whatever HEAD is now.
        const branchNow = resolution.branch !== null ? branchLabel(cwd) : null;
        if (resolution.branch !== null && branchNow !== resolution.branch) {
          return toToolResult(
            `git-me: the checked-out branch changed while the dialog was open ("${resolution.branch}" -> "${branchNow ?? "detached HEAD"}"). Nothing was created; re-run git_pr_upsert from the branch you want to publish.`,
          );
        }
        const args = [
          "pr",
          "create",
          "--title",
          title,
          "--body",
          body,
          "--base",
          base,
        ];
        if (params.draft) args.push("--draft");
        const result = runGh(args, cwd);
        if (result.exitCode !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim();
          return toToolResult(
            `git-me: \`gh pr create\` failed (exit ${result.exitCode}). ${detail}`,
          );
        }
        // gh pr create prints the new PR URL on stdout.
        const url = result.stdout.trim();
        return toToolResult(
          `Opened PR ${base} <- HEAD.\n  url: ${url}${extraText}`,
          details,
        );
      }

      // EDIT branch. Address the PR by NUMBER (not the current branch) so a
      // branch checkout between resolve and apply cannot edit the wrong PR,
      // and re-verify the identity the gate showed right before the write:
      // the human can merge, close, or retarget the PR while the dialog is
      // open (incident 2026-11-11 class). Any drift aborts; nothing is sent.
      const verified = verifyPrTarget(existing, cwd);
      if (!verified.ok) return toToolResult(verified.message);
      const result = runGh([
        "pr",
        "edit",
        String(existing.number),
        "--title",
        title,
        "--body",
        body,
      ], cwd);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return toToolResult(
          `git-me: \`gh pr edit\` failed (exit ${result.exitCode}). ${detail}`,
        );
      }
      return toToolResult(
        `Updated PR #${existing.number} (${existing.headRefName} -> ${existing.baseRefName}).\n  url: ${existing.url}${extraText}`,
        details,
      );
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
