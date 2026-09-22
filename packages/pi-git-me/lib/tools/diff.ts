import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { gitDiff } from "../git";
import { toToolResult, type GitDetails } from "../result";
import {
  GIT_DIFF_TITLE,
  GIT_DIFF_DESCRIPTION,
  GIT_DIFF_TARGET_DESCRIPTION,
  GIT_DIFF_BASE_DESCRIPTION,
  GIT_DIFF_MAX_BYTES_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  target: Type.Optional(
    Type.String({
      description: GIT_DIFF_TARGET_DESCRIPTION,
      enum: ["staged", "unstaged", "all", "branch"],
    }),
  ),
  base: Type.Optional(Type.String({ description: GIT_DIFF_BASE_DESCRIPTION })),
  max_bytes: Type.Optional(
    Type.Integer({
      description: GIT_DIFF_MAX_BYTES_DESCRIPTION,
      minimum: 1000,
      maximum: 1_000_000,
    }),
  ),
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

type DiffTarget = "staged" | "unstaged" | "all" | "branch";
const DIFF_TARGETS = ["staged", "unstaged", "all", "branch"] as const satisfies readonly DiffTarget[];

// Narrow the TypeBox `enum` constraint (which TS sees as plain string) to the
// literal union the rest of the code expects. Unknown / undefined -> default.
export function parseDiffTarget(raw: string | undefined): DiffTarget {
  return (DIFF_TARGETS as readonly string[]).includes(raw ?? "")
    ? (raw as DiffTarget)
    : "unstaged";
}

export const diffTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_diff",
  label: GIT_DIFF_TITLE,
  description: GIT_DIFF_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<GitDetails>> {
    const cwd = params.cwd ?? ctx.cwd;
    const text = gitDiff(
      parseDiffTarget(params.target),
      cwd,
      params.base ?? "main",
      params.max_bytes ?? 50_000,
    );
    return toToolResult(text);
  },
};
