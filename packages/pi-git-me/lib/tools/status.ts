import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { gitStatus } from "../git";
import { toToolResult, type GitDetails } from "../result";
import {
  GIT_STATUS_TITLE,
  GIT_STATUS_DESCRIPTION,
  GIT_STATUS_MAX_LINES_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  max_lines: Type.Optional(
    Type.Integer({
      description: GIT_STATUS_MAX_LINES_DESCRIPTION,
      minimum: 1,
      maximum: 5000,
    }),
  ),
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

export const statusTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_status",
  label: GIT_STATUS_TITLE,
  description: GIT_STATUS_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<GitDetails>> {
    const cwd = params.cwd ?? ctx.cwd;
    const text = gitStatus(cwd, params.max_lines ?? 200);
    return toToolResult(text);
  },
};
