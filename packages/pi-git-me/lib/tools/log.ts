import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { gitLog } from "../git";
import { toToolResult, type GitDetails } from "../result";
import {
  GIT_LOG_TITLE,
  GIT_LOG_DESCRIPTION,
  GIT_LOG_LIMIT_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      description: GIT_LOG_LIMIT_DESCRIPTION,
      minimum: 1,
      maximum: 100,
    }),
  ),
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

export const logTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_log",
  label: GIT_LOG_TITLE,
  description: GIT_LOG_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<GitDetails>> {
    const cwd = params.cwd ?? ctx.cwd;
    const entries = gitLog(params.limit ?? 10, cwd);
    if (entries.length === 0) {
      return toToolResult("(no commits on the current branch)");
    }
    const text = entries
      .map((e) => {
        const short = e.hash.slice(0, 7);
        const body = e.body ? `\n    ${e.body.replace(/\n/g, "\n    ")}` : "";
        return `${short} ${e.isoDate} ${e.author}: ${e.subject}${body}`;
      })
      .join("\n");
    return toToolResult(text);
  },
};
