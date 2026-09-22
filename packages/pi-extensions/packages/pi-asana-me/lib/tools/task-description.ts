import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaTaskCompact } from "../types";
import {
  GET_TASK_NOTES_TITLE,
  GET_TASK_NOTES_DESCRIPTION,
  GET_TASK_GID_DESCRIPTION,
} from "../prompts";

// asana_get_task deliberately truncates `notes` (2000 chars) to keep its
// default payload cheap; that cap hides the acceptance criteria, background,
// and implementation detail an agent needs to actually DO the task. This tool
// exists to recover the full body on demand: it asks only for name + notes,
// and prints notes with NO slice. Pair the two tools - cheap default read,
// full-body fetch only when the task is the work.
const Params = Type.Object({
  gid: Type.String({ description: GET_TASK_GID_DESCRIPTION }),
});

export const getTaskDescriptionTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_get_task_description",
  label: GET_TASK_NOTES_TITLE,
  description: GET_TASK_NOTES_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    try {
      const task = await callAsana<AsanaTaskCompact>(
        "GET",
        `/tasks/${encodeURIComponent(params.gid)}`,
        {
          query: { opt_fields: "name,notes" },
        },
      );
      const lines: string[] = [];
      lines.push(`Task ${task.gid}:`);
      lines.push(`  name: ${task.name ?? "(untitled)"}`);
      // Full notes, untruncated. Empty string when the task has no body.
      lines.push(`  description: ${task.notes ?? ""}`);
      return toToolResult(lines.join("\n"));
    } catch (err) {
      if (err instanceof AsanaError && err.status === 404) {
        return toToolResult(
          `Asana: task ${params.gid} not found. Verify the GID with \`asana_search_objects\` (resource_type=task).`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};
