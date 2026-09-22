import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaStory } from "../types";
import {
  TASK_COMMENTS_TITLE,
  TASK_COMMENTS_DESCRIPTION,
  TASK_COMMENTS_TASK_GID_DESCRIPTION,
  TASK_COMMENTS_LIMIT_DESCRIPTION,
} from "../prompts";

// Fetch the N most-recent comments on a single task. Comments live on the
// stories endpoint (`/tasks/{gid}/stories`).
//
// Two non-obvious behaviors that drive the implementation:
//   1. The endpoint paginates with `next_page.offset`; Asana caps page size
//      at 100. Tasks with active threads routinely exceed that across
//      system + human events combined, so a single page is not enough.
//      We loop on `next_page` until exhausted, capped at MAX_PAGES so a
//      malformed token can't loop forever.
//   2. The server's natural order is documented only by forum observation
//      (chronological-ascending per community reports) and is explicitly
//      NOT guaranteed. We sort by `created_at` desc client-side so that
//      `limit=N` returns the N most-recent N reliably regardless of how
//      Asana returned the rows.
//
// The discriminator for comments is `type === "comment"`. `resource_subtype`
// is an action verb ("comment_added", "assigned", "description_changed",
// ...) and is NOT the discriminator.

const MAX_PAGES = 10; // Asana documents ~1000-object truncation; 10 * 100 stays below.

// Cap each rendered comment body. Lists with active threads get expensive
// fast; this keeps the default payload readable. The footer names the
// recovery tool + story_gid so the agent can pull the whole body on demand
// via asana_get_comment. Mirrors the NOTES_LIMIT pattern in task.ts.
const COMMENT_LIMIT = 700;

interface ListPage<T> {
  data: T[];
  next_page?: { offset: string } | null;
}

interface FetchedStories {
  stories: AsanaStory[];
  hitCap: boolean;
}

async function fetchAllStories(taskGid: string): Promise<FetchedStories> {
  const collected: AsanaStory[] = [];
  let offset: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const p = await callAsana<ListPage<AsanaStory>>(
      "GET",
      `/tasks/${encodeURIComponent(taskGid)}/stories`,
      {
        query: {
          opt_fields: "text,created_at,created_by.name,type,resource_subtype",
          limit: 100,
          offset,
        },
        raw: true,
      },
    );
    const rows = Array.isArray(p.data) ? p.data : [];
    collected.push(...rows);
    const nextOffset = p.next_page?.offset;
    if (!nextOffset) {
      return { stories: collected, hitCap: false };
    }
    offset = nextOffset;
  }
  return { stories: collected, hitCap: true };
}

const Params = Type.Object({
  task_gid: Type.String({ description: TASK_COMMENTS_TASK_GID_DESCRIPTION }),
  limit: Type.Optional(
    Type.Number({ description: TASK_COMMENTS_LIMIT_DESCRIPTION, minimum: 1, maximum: 50 }),
  ),
});

export const getTaskCommentsTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_get_task_comments",
  label: TASK_COMMENTS_TITLE,
  description: TASK_COMMENTS_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    try {
      const { stories, hitCap } = await fetchAllStories(params.task_gid);
      const list = stories;

      // Comments only. The discriminator is `type === "comment"`.
      const human = list.filter((s) => s.type === "comment");

      // Sort newest-first. ISO 8601 strings sort lexicographically.
      // Comments missing `created_at` go last - we don't know if they're
      // recent and surfacing them first could push real latest comments
      // past the limit.
      const comments = human.slice().sort((a, b) => {
        if (!a.created_at && !b.created_at) return 0;
        if (!a.created_at) return 1;
        if (!b.created_at) return -1;
        return b.created_at.localeCompare(a.created_at);
      });

      const limit = params.limit ?? 5;
      const slice = comments.slice(0, limit);

      if (slice.length === 0) {
        return toToolResult(
          `Asana: no comments on task ${params.task_gid}${
            list.length > 0
              ? ` (${list.length} system story/stories exist but no human comments)`
              : ""
          }.`,
        );
      }

      const lines: string[] = [];
      lines.push(
        `Asana: ${slice.length} of ${comments.length} comment${comments.length === 1 ? "" : "s"} on task ${params.task_gid} (most recent first).`,
      );
      lines.push("");
      for (const c of slice) {
        const author = c.created_by?.name ?? "unknown author";
        const when = c.created_at ?? "(no timestamp)";
        lines.push(`- ${author} at ${when} (story gid: ${c.gid})`);
        const body = c.text ?? c.html_text ?? "";
        const truncated = body.length > COMMENT_LIMIT;
        const rendered = truncated ? body.slice(0, COMMENT_LIMIT) : body;
        if (rendered) {
          lines.push(rendered.split("\n").map((ln) => `  ${ln}`).join("\n"));
        }
        if (truncated) {
          lines.push(
            `  ... (truncated at ${COMMENT_LIMIT} chars; call asana_get_comment with story_gid=${c.gid} for the full text)`,
          );
        }
        lines.push("");
      }
      const remaining = comments.length - slice.length;
      if (remaining > 0) {
        lines.push(
          `(${remaining} older comment${remaining === 1 ? "" : "s"} not shown; raise the limit to see more.)`,
        );
      } else if (hitCap) {
        lines.push(
          "(Hit the local pagination cap; the task may have >1000 stories. Most tasks do not.)",
        );
      }
      return toToolResult(lines.join("\n").trimEnd());
    } catch (err) {
      if (err instanceof AsanaError && err.status === 404) {
        return toToolResult(
          `Asana: task ${params.task_gid} not found. Verify the GID with \`asana_search_objects\` (resource_type=task).`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};
