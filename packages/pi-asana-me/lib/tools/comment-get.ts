import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaStory } from "../types";
import {
  GET_COMMENT_TITLE,
  GET_COMMENT_DESCRIPTION,
  GET_COMMENT_STORY_GID_DESCRIPTION,
} from "../prompts";

// asana_get_task_comments deliberately truncates each comment body (~700
// chars) to keep its payload cheap when a task has an active thread; that
// cap hides the second half of a decision, rationale, or Q&A an agent
// needs to act on. This tool exists to recover the full body on demand:
// it asks only for the one story (by its gid) and prints the text with NO
// slice. Asana calls comments "stories" of type `comment`; GET
// `/stories/{gid}` returns the single story regardless of type, so this
// also works if a caller passes a system story gid (rare, but harmless).
// Pair the two tools: cheap list read, full-body fetch only when the one
// comment is the work.
const Params = Type.Object({
  story_gid: Type.String({ description: GET_COMMENT_STORY_GID_DESCRIPTION }),
});

export const getCommentTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_get_comment",
  label: GET_COMMENT_TITLE,
  description: GET_COMMENT_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    try {
      const story = await callAsana<AsanaStory>(
        "GET",
        `/stories/${encodeURIComponent(params.story_gid)}`,
        {
          query: {
            opt_fields: "text,html_text,created_at,created_by.name,type,resource_subtype",
          },
        },
      );
      const author = story.created_by?.name ?? "unknown author";
      const when = story.created_at ?? "(no timestamp)";
      const isComment = story.type === "comment";
      const lines: string[] = [];
      lines.push(
        `Comment ${story.gid} (by ${author} at ${when}${isComment ? "" : `, type=${story.type ?? "?"}`}):`,
      );
      // Full text, untruncated. Prefer plain `text`; fall back to `html_text`
      // (Asana returns one or the other depending on how the comment was
      // posted). Empty string when the story has no body. Use `||` not `??`:
      // if Asana returns `text: ""` while `html_text` carries the body, the
      // whole point of this tool is to recover it, so fall through on empty
      // string too.
      const body = story.text || story.html_text || "";
      // Indent the body 2 spaces to match asana_get_task_comments' list view,
      // so concatenating the two outputs reads consistently.
      lines.push(body.split("\n").map((ln) => `  ${ln}`).join("\n"));
      return toToolResult(lines.join("\n"));
    } catch (err) {
      if (err instanceof AsanaError && err.status === 404) {
        return toToolResult(
          `Asana: comment (story) ${params.story_gid} not found. The story gid is printed by asana_get_task_comments next to each comment as "(story gid: ...)"; re-run it to get a fresh gid.`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};
