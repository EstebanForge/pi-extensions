import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { confirmWrite, summarizeCreateTasks, willPromptForWrite } from "../confirm";
import { resolveTasks } from "../resolve";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaTaskCompact } from "../types";
import {
  CREATE_TASKS_TITLE,
  CREATE_TASKS_DESCRIPTION,
  CREATE_TASKS_WORKSPACE_DESCRIPTION,
  CREATE_TASKS_TASKS_DESCRIPTION,
} from "../prompts";

// Batch task creation. Asana's REST `POST /tasks` creates one task per call,
// so we honor the MCP "up to 50 per call" surface by looping client-side and
// aggregating. The whole batch is shown to the user for yes/no review before
// the first POST when the `asana-confirm-write` flag is on.
const TaskSpec = Type.Object({
  name: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  projects: Type.Optional(Type.Array(Type.String())),
  project: Type.Optional(Type.String()),
  section: Type.Optional(Type.String()),
  parent: Type.Optional(Type.String()),
  assignee: Type.Optional(Type.Union([Type.String(), Type.Literal("me")])),
  due_on: Type.Optional(Type.String()),
  start_on: Type.Optional(Type.String()),
  followers: Type.Optional(Type.Array(Type.String())),
});

const Params = Type.Object({
  workspace: Type.Optional(
    Type.String({ description: CREATE_TASKS_WORKSPACE_DESCRIPTION }),
  ),
  tasks: Type.Array(TaskSpec, {
    description: CREATE_TASKS_TASKS_DESCRIPTION,
    minItems: 1,
    maxItems: 50,
  }),
});

export const createTasksTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_create_tasks",
  label: CREATE_TASKS_TITLE,
  description: CREATE_TASKS_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<AsanaDetails>> {
    // Review-before-post gate (yes/no on a readable batch summary). New
    // tasks have no URL yet, but a subtask's `parent` is an existing task —
    // resolve those so the human sees where the subtasks will land.
    const parentGids = params.tasks
      .map((t) => t.parent)
      .filter((p): p is string => !!p);
    const resolved = willPromptForWrite(ctx) ? await resolveTasks(parentGids) : undefined;
    const decision = await confirmWrite(ctx, {
      title: `Create ${params.tasks.length} Asana task${
        params.tasks.length === 1 ? "" : "s"
      }?`,
      summary: summarizeCreateTasks(params.workspace, params.tasks, resolved),
    });
    if (!decision.proceed) {
      return toToolResult(
        `Asana: task creation cancelled by user (${params.tasks.length} task${
          params.tasks.length === 1 ? "" : "s"
        }). Nothing was posted.`,
      );
    }

    try {
      const created: AsanaTaskCompact[] = [];
      const failures: Array<{ index: number; error: string }> = [];

      for (let i = 0; i < params.tasks.length; i++) {
        const spec = params.tasks[i] ?? {};
        try {
          if (spec.projects !== undefined && spec.project !== undefined) {
            failures.push({
              index: i,
              error:
                'task spec sets both "projects" (array) and "project" (singular); pick one. Refusing to overwrite.',
            });
            continue;
          }
          const body: Record<string, unknown> = {};
          if (spec.name !== undefined) body.name = spec.name;
          if (spec.notes !== undefined) body.notes = spec.notes;
          if (spec.projects !== undefined) body.projects = spec.projects;
          if (spec.project !== undefined) body.projects = [spec.project];
          if (spec.section !== undefined) body.section = spec.section;
          if (spec.parent !== undefined) body.parent = spec.parent;
          if (spec.assignee !== undefined) body.assignee = spec.assignee;
          if (spec.due_on !== undefined) body.due_on = spec.due_on;
          if (spec.start_on !== undefined) body.start_on = spec.start_on;
          if (spec.followers !== undefined) body.followers = spec.followers;
          if (params.workspace !== undefined) body.workspace = params.workspace;

          const task = await callAsana<AsanaTaskCompact>("POST", "/tasks", {
            query: { opt_fields: "name,projects,assignee.name,permalink_url" },
            body,
          });
          created.push(task);
        } catch (err) {
          failures.push({
            index: i,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const lines: string[] = [];
      lines.push(
        `Asana: ${created.length} of ${params.tasks.length} task${params.tasks.length === 1 ? "" : "s"} created.`,
      );
      for (const t of created) {
        const url = t.permalink_url ? ` ${t.permalink_url}` : "";
        lines.push(`- ${t.name ?? "(untitled)"} (gid: ${t.gid})${url}`);
      }
      if (failures.length > 0) {
        lines.push("");
        lines.push(`Failures (${failures.length}):`);
        for (const f of failures) {
          lines.push(`- task #${f.index + 1}: ${f.error}`);
        }
      }
      return toToolResult(lines.join("\n"));
    } catch (err) {
      if (err instanceof AsanaError && err.status === 401) {
        return toToolResult(
          `Asana error: PAT cannot create tasks. ${err.message}`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};
