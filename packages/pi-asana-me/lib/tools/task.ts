import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaTaskCompact, AsanaRef } from "../types";
import {
  GET_TASK_TITLE,
  GET_TASK_DESCRIPTION,
  GET_TASK_GID_DESCRIPTION,
  GET_TASK_OPT_FIELDS_DESCRIPTION,
} from "../prompts";

// Default opt_fields when the caller does not pass their own. Matches the MCP
// `get_task` description surface ("name, description, assignee, due dates,
// custom fields, project memberships, dependencies, subtasks, and comments").
// Comments themselves live on the stories endpoint and are NOT returned here;
// use asana_get_task_comments to fetch them.
//
// For parent / dependencies / subtasks we ask for the .gid and .name on the
// nested resource so the agent gets useful rows without a second round-trip.
// Without this, callers who omitted opt_fields got a sparse projection that
// hid the very fields the description advertised (caught during live testing
// on a task with several closed subtasks the agent could not see).
const DEFAULT_OPT_FIELDS = [
  "name",
  "notes",
  "completed",
  "completed_at",
  "assignee.name",
  "due_on",
  "due_at",
  "start_on",
  "created_at",
  "modified_at",
  "projects.name",
  "tags.name",
  "custom_fields.name",
  "custom_fields.display_value",
  "memberships.project.name",
  "memberships.section.name",
  "subtasks.name",
  "subtasks.completed",
  "subtasks.completed_at",
  "subtasks.assignee.name",
  "parent.gid",
  "parent.name",
  "dependencies.gid",
  "dependencies.name",
  "dependents.gid",
  "dependents.name",
  "followers.name",
].join(",");

const Params = Type.Object({
  gid: Type.String({ description: GET_TASK_GID_DESCRIPTION }),
  opt_fields: Type.Optional(
    Type.String({ description: GET_TASK_OPT_FIELDS_DESCRIPTION }),
  ),
});

function formatRefList(refs: AsanaRef[] | undefined, indent: string): string[] {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  return refs.map((r) => `${indent}- ${r.name ?? "(unnamed)"} (gid: ${r.gid})`);
}

export const getTaskTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_get_task",
  label: GET_TASK_TITLE,
  description: GET_TASK_DESCRIPTION,
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
          query: {
            opt_fields: params.opt_fields ?? DEFAULT_OPT_FIELDS,
          },
        },
      );
      const lines: string[] = [];
      lines.push(`Task ${task.gid}:`);
      lines.push(`  name: ${task.name ?? "(untitled)"}`);
      const completedAt = typeof task.completed_at === "string" ? ` (at ${task.completed_at})` : "";
      lines.push(`  completed: ${Boolean(task.completed)}${completedAt}`);
      if (typeof task.due_on === "string") lines.push(`  due_on: ${task.due_on}`);
      if (typeof task.due_at === "string") lines.push(`  due_at: ${task.due_at}`);
      if (typeof task.start_on === "string") lines.push(`  start_on: ${task.start_on}`);
      if (typeof task.created_at === "string") lines.push(`  created_at: ${task.created_at}`);
      if (typeof task.modified_at === "string") lines.push(`  modified_at: ${task.modified_at}`);
      // asana_get_task deliberately caps notes to keep the default payload
      // cheap; when the body overflows the cap, point the agent at
      // asana_get_task_description to recover the full, untruncated text.
      // The cap sits just below the worst-case "long-ish spec" so everyday
      // tasks render inline without the marker.
      const NOTES_LIMIT = 2000;
      if (typeof task.notes === "string") {
        if (task.notes.length > NOTES_LIMIT) {
          lines.push(
            `  notes: ${task.notes.slice(0, NOTES_LIMIT)}... [truncated; call asana_get_task_description for the full text]`,
          );
        } else {
          lines.push(`  notes: ${task.notes}`);
        }
      }

      // Parent (this task is a subtask of <X>).
      if (task.parent?.gid) {
        lines.push(`  parent: ${task.parent.name ?? "(unnamed)"} (gid: ${task.parent.gid})`);
      }

      // Projects this task is in.
      const projectLines = formatRefList(task.projects, "    -");
      if (projectLines.length > 0) {
        lines.push(`  projects:`);
        lines.push(...projectLines);
      }

      if (Array.isArray(task.memberships)) {
        const sections = task.memberships.filter((m) => m.section);
        if (sections.length > 0) {
          lines.push(`  sections:`);
          for (const s of sections) {
            const project = s.project?.name ?? "(unnamed)";
            const name = s.section?.name ?? "(unnamed)";
            lines.push(`    - ${name} (in project: ${project})`);
          }
        }
      }

      if (task.tags && task.tags.length > 0) {
        lines.push(`  tags: ${task.tags.map((t) => t.name ?? "(unnamed)").join(", ")}`);
      }
      if (task.followers && task.followers.length > 0) {
        lines.push(`  followers: ${task.followers.map((f) => f.name ?? "(unnamed)").join(", ")}`);
      }

      const depLines = formatRefList(task.dependencies, "    -");
      if (depLines.length > 0) {
        lines.push(`  dependencies (this task depends on):`);
        lines.push(...depLines);
      }
      const dependentLines = formatRefList(task.dependents, "    -");
      if (dependentLines.length > 0) {
        lines.push(`  dependents (blocked on this task):`);
        lines.push(...dependentLines);
      }

      const visibleFields = (task.custom_fields ?? []).filter(
        (cf) => cf.display_value != null && cf.display_value !== "",
      );
      if (visibleFields.length > 0) {
        lines.push(`  custom fields:`);
        for (const cf of visibleFields) {
          lines.push(`    - ${cf.name ?? "(unnamed)"}: ${cf.display_value}`);
        }
      }

      // Subtasks. Caught during live testing: a closed parent with N closed
      // subtasks rendered as "no subtasks" until these fields were added.
      const subtasks = task.subtasks ?? [];
      if (subtasks.length > 0) {
        const closedCount = subtasks.filter((s) => s.completed).length;
        lines.push(`  subtasks (${subtasks.length} total, ${closedCount} closed):`);
        for (const s of subtasks) {
          const done = s.completed ? "x" : " ";
          const at =
            s.completed && typeof s.completed_at === "string" ? ` at ${s.completed_at}` : "";
          const owner = s.assignee?.name ?? "unassigned";
          lines.push(`    - [${done}] ${s.name ?? "(untitled)"} (gid: ${s.gid}) - ${owner}${at}`);
        }
      } else {
        lines.push(`  subtasks: none`);
      }

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
