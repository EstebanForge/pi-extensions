import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runGh, requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { describeTitleBodyPayload, repoContextLabel, toTitleBodyPrefill, fromTitleBodyPrefill } from "../format";
import { toToolResult, errorText, postedContentExtras, type GitDetails } from "../result";
import {
  ISSUE_CREATE_TITLE,
  ISSUE_CREATE_DESCRIPTION,
  ISSUE_CREATE_TITLE_DESCRIPTION,
  ISSUE_CREATE_BODY_DESCRIPTION,
  ISSUE_CREATE_LABELS_DESCRIPTION,
  ISSUE_CREATE_ASSIGNEES_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

// Create a new GitHub issue. The agent supplies title + body (and optional
// labels / assignees); this tool runs the two-stage human gate (headless
// guard + editable preview with title and body in one buffer) and then
// applies via `gh issue create`, which prints the new issue URL on stdout.

const Params = Type.Object({
  title: Type.String({ description: ISSUE_CREATE_TITLE_DESCRIPTION, minLength: 1 }),
  body: Type.String({ description: ISSUE_CREATE_BODY_DESCRIPTION, minLength: 1 }),
  labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: ISSUE_CREATE_LABELS_DESCRIPTION })),
  assignees: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: ISSUE_CREATE_ASSIGNEES_DESCRIPTION })),
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

export const issueCreateTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_issue_create",
  label: ISSUE_CREATE_TITLE,
  description: ISSUE_CREATE_DESCRIPTION,
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

    const prefill = toTitleBodyPrefill(params.title, params.body);
    const summary = describeTitleBodyPayload(params.title, params.body);

    const decision = await confirmWrite(ctx, {
      title: `Create a new issue with this title + body?${repoContextLabel(cwd, ctx.cwd)}`,
      editableText: prefill,
      summary,
      // gh receives the title and body as separate, trimmed flags. Mirror
      // that split+trim here so a whitespace-only edit inside either field
      // does not register as edited when the transmitted fields are unchanged.
      normalize: (s) => {
        const r = fromTitleBodyPrefill(s, params.title);
        return `${r.title}\n${r.body}`;
      },
    });
    if (!decision.proceed) {
      return toToolResult(
        ctx.hasUI
          ? "git-me: issue creation cancelled by user. Nothing was sent to gh."
          : "git-me: issue not created (headless mode; no UI to review). Use /git headless on to allow unsupervised issue creation.",
      );
    }

    const { title, body } = fromTitleBodyPrefill(decision.text ?? prefill, params.title);
    if (!title || !body) {
      return toToolResult(
        "git-me: issue title and body are both required. Edit left one empty; nothing was created.",
      );
    }
    const postedContent = `Title: ${title}\n\n${body}`;
    const { extraText, details } = postedContentExtras(postedContent, decision.edited ?? false);

    try {
      // Repeated flags (not comma-joined) so a label or login containing a
      // comma cannot smuggle a second value into one flag.
      const args = ["issue", "create", "--title", title, "--body", body];
      for (const label of params.labels ?? []) args.push("--label", label);
      for (const assignee of params.assignees ?? []) args.push("--assignee", assignee);
      const result = runGh(args, cwd);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return toToolResult(
          `git-me: \`gh issue create\` failed (exit ${result.exitCode}). ${detail}`,
        );
      }
      // gh issue create prints the new issue URL on stdout. A label or
      // assignee gh rejects fails the whole call, so the URL means created.
      const url = result.stdout.trim();
      return toToolResult(`Created issue.\n  url: ${url}${extraText}`, details);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
