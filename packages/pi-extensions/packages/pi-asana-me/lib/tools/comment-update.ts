import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { confirmWrite } from "../confirm";
import { toToolResult, errorText, postedContentExtras, type AsanaDetails } from "../result";
import type { AsanaStory } from "../types";
import { validateHtmlText } from "./comment-add";
import {
  UPDATE_COMMENT_TITLE,
  UPDATE_COMMENT_DESCRIPTION,
  UPDATE_COMMENT_STORY_GID_DESCRIPTION,
  UPDATE_COMMENT_TEXT_DESCRIPTION,
  UPDATE_COMMENT_HTML_DESCRIPTION,
} from "../prompts";

// Edit the text of a comment previously posted on a task. Asana calls
// comments "stories"; PUT `/stories/{gid}` with `text` (or `html_text` when
// markup was supplied). Asana only allows the PAT owner to edit their own
// comments (`is_editable: true` on the story); system stories and other
// people's comments are refused. The existing story is fetched first to
// check editability BEFORE the review dialog or any PUT.
const Params = Type.Object({
  story_gid: Type.String({ description: UPDATE_COMMENT_STORY_GID_DESCRIPTION }),
  text: Type.String({ description: UPDATE_COMMENT_TEXT_DESCRIPTION, minLength: 1 }),
  html: Type.Optional(
    Type.Boolean({ description: UPDATE_COMMENT_HTML_DESCRIPTION }),
  ),
});

export const updateCommentTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_update_comment",
  label: UPDATE_COMMENT_TITLE,
  description: UPDATE_COMMENT_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<AsanaDetails>> {
    // Same fail-fast html_text guard as asana_add_comment, BEFORE any network
    // call: Asana's silent literal-text fallback gives no HTTP signal.
    if (params.html) {
      const problems = validateHtmlText(params.text);
      if (problems.length > 0) {
        return toToolResult(
          `Asana: refused to edit comment ${params.story_gid} as html_text. Fix and retry, or drop the html flag to send plain text:\n- ${problems.join("\n- ")}`,
        );
      }
    }

    // Fetch the story first: verifies it exists AND that the PAT owner may
    // edit it, before the review dialog or any PUT.
    let existing: AsanaStory;
    try {
      existing = await callAsana<AsanaStory>(
        "GET",
        `/stories/${encodeURIComponent(params.story_gid)}`,
        {
          query: {
            opt_fields: "gid,text,is_editable,type,created_by.name,created_at",
          },
        },
      );
    } catch (err) {
      if (err instanceof AsanaError && err.status === 404) {
        return toToolResult(
          `Asana: comment (story) ${params.story_gid} not found. The story gid is printed by asana_get_task_comments next to each comment as "(story gid: ...)"; re-run it to get a fresh gid.`,
        );
      }
      return toToolResult(errorText(err));
    }

    if (existing.is_editable === false) {
      const author = existing.created_by?.name ?? "another user";
      const what =
        existing.type === "system"
          ? "a system story"
          : existing.created_by
            ? `by ${author}`
            : "not editable for this token";
      return toToolResult(
        `Asana: comment ${params.story_gid} is not editable (${what}). Asana only allows the authenticated user to edit their own comments. Post a new comment with asana_add_comment instead.`,
      );
    }

    // Review-before-write gate. The editor is prefilled with the NEW text so
    // the human edits the replacement, not the old body.
    const decision = await confirmWrite(ctx, {
      title: `Edit comment ${params.story_gid}?`,
      editableText: params.text,
      summary: params.text,
    });
    if (!decision.proceed) {
      return toToolResult(
        `Asana: edit of comment ${params.story_gid} cancelled by user. Nothing was changed.`,
      );
    }
    const text = decision.text ?? params.text;

    try {
      const body = params.html ? { html_text: text } : { text };
      const story = await callAsana<AsanaStory>(
        "PUT",
        `/stories/${encodeURIComponent(params.story_gid)}`,
        {
          query: { opt_fields: "gid,text,resource_type,created_at" },
          body,
        },
      );
      const { extraText, details } = postedContentExtras(text, decision.edited ?? false);
      return toToolResult(
        `Asana: comment ${params.story_gid} updated (story gid: ${story.gid}, at ${
          story.created_at ?? existing.created_at ?? "(no timestamp)"
        }).${extraText}`,
        details,
      );
    } catch (err) {
      if (err instanceof AsanaError && (err.status === 400 || err.status === 403)) {
        // Surface the upstream message; 400/403 here usually mean a
        // permission/validity refusal, but guessing the cause hides detail.
        return toToolResult(
          `Asana: comment ${params.story_gid} could not be edited (HTTP ${err.status}): ${err.message} If this is a permission refusal, note Asana only allows editing comments you posted yourself; post a new comment with asana_add_comment instead.`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};
