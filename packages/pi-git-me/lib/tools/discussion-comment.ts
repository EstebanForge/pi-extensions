import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { describeReviewPayload, repoContextLabel } from "../format";
import {
  ghRepoView,
  ghGraphql,
  GhGraphqlError,
  DISCUSSION_BY_NUMBER_QUERY,
  ADD_DISCUSSION_COMMENT_MUTATION,
  parseDiscussion,
  resolveDiscussionCommentNodeId,
} from "../github";
import { toToolResult, errorText, postedContentExtras, type GitDetails } from "../result";
import {
  validateAttachmentPaths,
  uploadAttachmentsForComment,
  appendAttachments,
  type UploadedAttachment,
} from "../attachment-upload";
import {
  DISCUSSION_COMMENT_TITLE,
  DISCUSSION_COMMENT_DESCRIPTION,
  DISCUSSION_COMMENT_BODY_DESCRIPTION,
  DISCUSSION_COMMENT_NUMBER_DESCRIPTION,
  DISCUSSION_COMMENT_REPLY_TO_DESCRIPTION,
  COMMENT_IMAGES_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

// Post a comment on a GitHub Discussion, or a threaded REPLY to one of its
// comments. Same GraphQL path as git_discussion_create (no gh CLI command
// exists): resolve the discussion by number, resolve the optional reply
// target to its node id, gate the body, then run addDiscussionComment —
// without replyToId it lands as a top-level comment, with it as a reply
// nested under that comment.
//
// Note for ISSUES: issue comments are flat (no threading); replying to an
// issue is git_issue_comment's job. This tool is discussions-only.

const Params = Type.Object({
  number: Type.Integer({
    description: DISCUSSION_COMMENT_NUMBER_DESCRIPTION,
    minimum: 1,
  }),
  body: Type.String({ description: DISCUSSION_COMMENT_BODY_DESCRIPTION, minLength: 1 }),
  images: Type.Optional(
    Type.Array(Type.String({ description: COMMENT_IMAGES_DESCRIPTION })),
  ),
  replyTo: Type.Optional(Type.String({ description: DISCUSSION_COMMENT_REPLY_TO_DESCRIPTION, minLength: 1 })),
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

export const discussionCommentTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_discussion_comment",
  label: DISCUSSION_COMMENT_TITLE,
  description: DISCUSSION_COMMENT_DESCRIPTION,
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

    try {
      const repo = ghRepoView(cwd);
      if (!repo) {
        return toToolResult(
          `git-me: could not resolve a GitHub repository for "${cwd}" (\`gh repo view\` failed). Check that the repo has a GitHub remote and that \`gh\` can see it.`,
        );
      }

      // Resolve the discussion BEFORE the gate (fail fast, and the dialog can
      // name the discussion being replied to).
      const discussion = parseDiscussion(
        ghGraphql(
          DISCUSSION_BY_NUMBER_QUERY,
          { owner: repo.owner, name: repo.name, number: params.number },
          cwd,
        ),
      );
      if (!discussion) {
        return toToolResult(
          `git-me: no discussion #${params.number} found in ${repo.nameWithOwner}. The number may be wrong, or Discussions are disabled for this repository.`,
        );
      }

      // Optional threaded-reply target, resolved to the node id the mutation
      // needs. Also resolved before the gate: a bad comment id is a doomed
      // write, no point opening the editor for it. Attachment paths get the
      // same local pre-gate check.
      let replyToId: string | undefined;
      if (params.replyTo) {
        const resolved = resolveDiscussionCommentNodeId(params.replyTo, repo, cwd);
        if ("error" in resolved) return toToolResult(resolved.error);
        replyToId = resolved.nodeId;
      }
      const imagePaths = params.images ?? [];
      if (imagePaths.length > 0) {
        const problems = await validateAttachmentPaths(imagePaths);
        if (problems.length > 0) {
          return toToolResult(
            `git-me: refused to post comment (discussion #${params.number}) - attachment problem(s):\n- ${problems.join("\n- ")}`,
          );
        }
      }

      const decision = await confirmWrite(ctx, {
        title: params.replyTo
          ? `Post this reply in discussion #${params.number} "${discussion.title}"?${repoContextLabel(cwd, ctx.cwd)}`
          : `Post this comment on discussion #${params.number} "${discussion.title}"?${repoContextLabel(cwd, ctx.cwd)}`,
        editableText: params.body,
        summary:
          describeReviewPayload(params.body) +
          (imagePaths.length > 0
            ? `\n\n[attach: ${imagePaths.map((p) => p.split("/").pop()).join(", ")}]`
            : ""),
        normalize: (s) => s.trimEnd(),
      });
      if (!decision.proceed) {
        return toToolResult(
          ctx.hasUI
            ? `git-me: discussion comment cancelled by user. Nothing was sent to gh.`
            : `git-me: discussion comment not posted (headless mode; no UI to review). Use /git headless on to allow unsupervised comments.`,
        );
      }

      let body = (decision.text ?? params.body).trimEnd();
      if (!body) {
        return toToolResult(
          "git-me: discussion comment body is empty after edit; nothing was posted.",
        );
      }

      // Upload AFTER the gate (cancel = zero side effects), BEFORE the
      // mutation (a failed upload must not leave a comment with dangling
      // references). The repo is already resolved above.
      let uploaded: UploadedAttachment[] = [];
      if (imagePaths.length > 0) {
        try {
          uploaded = await uploadAttachmentsForComment({
            paths: imagePaths,
            nameWithOwner: repo.nameWithOwner,
            cwd,
          });
        } catch (err) {
          return toToolResult(errorText(err));
        }
        body = appendAttachments(body, uploaded);
      }

      // Omit the variable entirely when not replying: an empty-string ID is
      // not null to GraphQL, it is a (broken) ID literal.
      const variables: Record<string, string | number> = { discussionId: discussion.id, body };
      if (replyToId !== undefined) variables.replyToId = replyToId;

      const data = ghGraphql(ADD_DISCUSSION_COMMENT_MUTATION, variables, cwd);
      const comment = (data.addDiscussionComment as { comment?: { url?: string } } | undefined)?.comment;
      if (!comment?.url) {
        return toToolResult(
          "git-me: the addDiscussionComment mutation returned no comment url; verify on GitHub whether it was posted.",
        );
      }
      const { extraText, details } = postedContentExtras(body, decision.edited ?? false);
      const what = params.replyTo ? "Reply posted" : "Comment posted";
      const attachPart = uploaded.length > 0 ? ` Attached ${uploaded.length} image(s).` : "";
      return toToolResult(
        `${what} on discussion #${params.number}.${attachPart}\n  url: ${comment.url}${extraText}`,
        details,
      );
    } catch (err) {
      if (err instanceof GhGraphqlError) return toToolResult(err.message);
      return toToolResult(errorText(err));
    }
  },
};
