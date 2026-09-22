import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaTaskCompact } from "../types";
import {
  GET_MY_TASKS_TITLE,
  GET_MY_TASKS_DESCRIPTION,
  GET_MY_TASKS_COMPLETED_DESCRIPTION,
} from "../prompts";

// Shortcut for asana_get_tasks with assignee=me, scoped to a workspace. Asana
// rejects assignee-without-workspace with 400, so the workspace is REQUIRED
// here - failing closed at the tool boundary is the right UX (clearer
// than a raw 400).
const Params = Type.Object({
  workspace: Type.String({
    description:
      "Workspace GID. Required; Asana rejects assignee=me without a workspace. Get one from asana_get_me if unknown.",
  }),
  completed: Type.Optional(
    Type.Union([Type.Literal("incomplete"), Type.Literal("completed")], {
      description: GET_MY_TASKS_COMPLETED_DESCRIPTION,
    }),
  ),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
});

export const getMyTasksTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_get_my_tasks",
  label: GET_MY_TASKS_TITLE,
  description: GET_MY_TASKS_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    try {
      // `completed=true|false` Asana param is the inverse of our `completed`
      // string enum. We translate: omitted = both; "incomplete" = false;
      // "completed" = true.
      const query: Record<string, string | number | boolean | undefined> = {
        assignee: "me",
        workspace: params.workspace,
        opt_fields: "name,completed,due_on,projects.name,memberships.section.name",
        limit: params.limit ?? 50,
      };
      if (params.completed === "incomplete") query.completed = false;
      else if (params.completed === "completed") query.completed = true;

      const list = await callAsana<AsanaTaskCompact[]>("GET", "/tasks", { query });
      const rows = list.map((t) => {
        const due = typeof t.due_on === "string" ? ` (due ${t.due_on})` : "";
        const done = t.completed ? "x" : " ";
        return `- [${done}] ${t.name ?? "(untitled)"} (gid: ${t.gid})${due}`;
      });
      const header = `Asana: ${list.length} task${list.length === 1 ? "" : "s"} assigned to you in workspace ${params.workspace}${
        params.completed ? ` (${params.completed})` : ""
      }.`;
      return toToolResult(
        list.length === 0
          ? `${header}\n(No tasks assigned to you matched the filter.)`
          : `${header}\n${rows.join("\n")}`,
      );
    } catch (err) {
      if (err instanceof AsanaError && err.status === 401) {
        return toToolResult(
          `Asana error: ${err.message} (Note: assignee=me is the authenticated user; re-run asana_get_me to confirm who the PAT belongs to.)`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};
