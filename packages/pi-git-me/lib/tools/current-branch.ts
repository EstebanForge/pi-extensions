import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { gitCurrentBranch } from "../git";
import { toToolResult, type GitDetails } from "../result";
import {
  GIT_CURRENT_BRANCH_TITLE,
  GIT_CURRENT_BRANCH_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

export const currentBranchTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_current_branch",
  label: GIT_CURRENT_BRANCH_TITLE,
  description: GIT_CURRENT_BRANCH_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId,
    params,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<GitDetails>> {
    const cwd = params.cwd ?? ctx.cwd;
    const branch = gitCurrentBranch(cwd);
    return toToolResult(branch || "(not inside a git repository)");
  },
};
