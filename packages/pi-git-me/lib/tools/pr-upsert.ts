import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runGh, requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { describeTitleBodyPayload, repoContextLabel, toTitleBodyPrefill, fromTitleBodyPrefill } from "../format";
import { ghPrForCurrentBranch } from "../git";
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

    // Resolve existing PR BEFORE the gate (requireGh above ruled out
    // gh-missing / gh-unauthed, so null genuinely means "no PR"). This lets
    // the dialog tell the user whether they are CREATING a new public PR or
    // OVERWRITING an existing one - materially different consequences that
    // used to share one vague prompt.
    const existing = ghPrForCurrentBranch(cwd);
    const base = params.base ?? "main";

    const prefill = toTitleBodyPrefill(params.title, params.body);
    const summary = describeTitleBodyPayload(params.title, params.body);

    const decision = await confirmWrite(ctx, {
      title:
        existing === null
          ? `Open a new PR (${base} <- HEAD) with this title + body?${repoContextLabel(cwd, ctx.cwd)}`
          : `Overwrite PR #${existing.number} title + body?${repoContextLabel(cwd, ctx.cwd)}`,
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
        // CREATE branch.
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
      // branch checkout between resolve and apply cannot edit the wrong PR.
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
