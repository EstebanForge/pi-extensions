import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { ghPrForCurrentBranch } from "../git";
import { toToolResult, type GitDetails } from "../result";
import {
  GIT_PR_INFO_TITLE,
  GIT_PR_INFO_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

export const prInfoTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_pr_info",
  label: GIT_PR_INFO_TITLE,
  description: GIT_PR_INFO_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId,
    params,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<GitDetails>> {
    const cwd = params.cwd ?? ctx.cwd;
    // Preflight env so a missing repo or missing/unauthed `gh` surfaces one
    // actionable error instead of a generic "no PR" that hides the cause.
    try {
      requireGitRepo(cwd);
      requireGh();
    } catch (err) {
      if (err instanceof GitMeEnvError) return toToolResult(err.message);
      throw err;
    }
    const pr = ghPrForCurrentBranch(cwd);
    if (!pr) {
      return toToolResult(
        "git-me: no PR found for the current branch. Use git_pr_upsert to open one, or pass a different branch.",
      );
    }
    const lines = [
      `#${pr.number} ${pr.title}`,
      `state: ${pr.state}${pr.isDraft ? " (draft)" : ""}`,
      `branch: ${pr.headRefName} -> ${pr.baseRefName}`,
      `url: ${pr.url}`,
      pr.author ? `author: ${pr.author.login}` : null,
      pr.reviewDecision ? `review: ${pr.reviewDecision}` : null,
      "",
      "body:",
      pr.body || "(empty)",
    ].filter((l): l is string => l !== null);
    return toToolResult(lines.join("\n"));
  },
};
