import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaTaskCompact } from "../types";
import {
  GET_TASKS_TITLE,
  GET_TASKS_DESCRIPTION,
  GET_TASKS_PROJECT_DESCRIPTION,
  GET_TASKS_SECTION_DESCRIPTION,
  GET_TASKS_TAG_DESCRIPTION,
  GET_TASKS_ASSIGNEE_DESCRIPTION,
  GET_TASKS_WORKSPACE_DESCRIPTION,
  GET_TASKS_COMPLETED_SINCE_DESCRIPTION,
  GET_TASKS_COMPLETED_BEFORE_DESCRIPTION,
  GET_TASKS_MODIFIED_SINCE_DESCRIPTION,
  GET_TASKS_LIMIT_DESCRIPTION,
} from "../prompts";

// Filtered task list. /tasks requires at least one filter, and Asana rejects
// the combination `assignee alone` / `workspace alone` - either pick a
// project/section/tag, or supply assignee AND workspace together. We validate
// at the tool boundary so the agent sees an actionable message instead of a
// raw 400 round-trip.
const Params = Type.Object({
  workspace: Type.Optional(Type.String({ description: GET_TASKS_WORKSPACE_DESCRIPTION })),
  project: Type.Optional(Type.String({ description: GET_TASKS_PROJECT_DESCRIPTION })),
  section: Type.Optional(Type.String({ description: GET_TASKS_SECTION_DESCRIPTION })),
  tag: Type.Optional(Type.String({ description: GET_TASKS_TAG_DESCRIPTION })),
  assignee: Type.Optional(Type.String({ description: GET_TASKS_ASSIGNEE_DESCRIPTION })),
  completed_since: Type.Optional(
    Type.String({ description: GET_TASKS_COMPLETED_SINCE_DESCRIPTION }),
  ),
  completed_before: Type.Optional(
    Type.String({ description: GET_TASKS_COMPLETED_BEFORE_DESCRIPTION }),
  ),
  modified_since: Type.Optional(
    Type.String({ description: GET_TASKS_MODIFIED_SINCE_DESCRIPTION }),
  ),
  limit: Type.Optional(
    Type.Number({ description: GET_TASKS_LIMIT_DESCRIPTION, minimum: 1, maximum: 100 }),
  ),
});

export const getTasksTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_get_tasks",
  label: GET_TASKS_TITLE,
  description: GET_TASKS_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    try {
      const hasProjectScope = Boolean(params.project || params.section || params.tag);
      const hasAssigneeScope = Boolean(params.assignee);

      if (!hasProjectScope && !hasAssigneeScope && !params.workspace) {
        return toToolResult(
          "Asana error: asana_get_tasks requires at least one of project / section / tag, " +
            "or both workspace + assignee. Pick the smallest scope the user wants.",
        );
      }
      if (hasAssigneeScope && !params.workspace && !hasProjectScope) {
        return toToolResult(
          "Asana error: asana_get_tasks with assignee set also requires a workspace " +
            "(or a project / section / tag). Pass \"workspace\" alongside \"assignee\", " +
            "or run `asana_get_me` first to discover one.",
        );
      }
      if (params.workspace && !hasAssigneeScope && !hasProjectScope) {
        return toToolResult(
          "Asana error: asana_get_tasks with only a workspace is not a supported filter. " +
            "Add an assignee, project, section, or tag.",
        );
      }

      const query: Record<string, string | number | undefined> = {
        opt_fields: "name,completed,assignee.name,due_on,projects.name,memberships.section.name",
        limit: params.limit ?? 50,
      };
      if (params.workspace) query.workspace = params.workspace;
      if (params.project) query.project = params.project;
      if (params.section) query.section = params.section;
      if (params.tag) query.tag = params.tag;
      if (params.assignee) query.assignee = params.assignee;
      if (params.completed_since) query.completed_since = params.completed_since;
      if (params.completed_before) query.completed_before = params.completed_before;
      if (params.modified_since) query.modified_since = params.modified_since;

      const list = await callAsana<AsanaTaskCompact[]>("GET", "/tasks", { query });
      const rows = list.map((t) => {
        const due = typeof t.due_on === "string" ? ` (due ${t.due_on})` : "";
        const done = t.completed ? "x" : " ";
        const assignee = t.assignee?.name ?? "unassigned";
        return `- [${done}] ${t.name ?? "(untitled)"} (gid: ${t.gid}) - ${assignee}${due}`;
      });
      const header = `Asana: ${list.length} task${list.length === 1 ? "" : "s"} matched the filter.`;
      return toToolResult(
        list.length === 0
          ? `${header}\n(No tasks matched the filter.)`
          : `${header}\n${rows.join("\n")}`,
      );
    } catch (err) {
      if (err instanceof AsanaError && err.status === 400) {
        return toToolResult(
          `Asana: filter combination is not allowed by the REST API. ${err.message}`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};
