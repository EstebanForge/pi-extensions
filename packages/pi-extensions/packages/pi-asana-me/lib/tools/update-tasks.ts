import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { callAsana } from "../api";
import { confirmWrite, summarizeUpdateTasks, willPromptForWrite } from "../confirm";
import { resolveTasks } from "../resolve";
import { toToolResult, type AsanaDetails } from "../result";
import type { AsanaTaskCompact } from "../types";
import {
  UPDATE_TASKS_TITLE,
  UPDATE_TASKS_DESCRIPTION,
  UPDATE_TASKS_TASKS_DESCRIPTION,
} from "../prompts";

// Batch task update. Each entry MUST carry a GID; only the fields supplied are
// mutated. `completed: true` is the closest thing Asana has to a "close task"
// verb and is what update_tasks should be called with for batch closures.
const TaskUpdate = Type.Object({
  gid: Type.String(),
  name: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  completed: Type.Optional(Type.Boolean()),
  assignee: Type.Optional(Type.Union([Type.String(), Type.Literal("me")])),
  due_on: Type.Optional(Type.String()),
  start_on: Type.Optional(Type.String()),
  projects: Type.Optional(Type.Array(Type.String())),
  section: Type.Optional(Type.String()),
  parent: Type.Optional(Type.String()),
  followers: Type.Optional(Type.Array(Type.String())),
});

const Params = Type.Object({
  tasks: Type.Array(TaskUpdate, {
    description: UPDATE_TASKS_TASKS_DESCRIPTION,
    minItems: 1,
    maxItems: 50,
  }),
});

export const updateTasksTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_update_tasks",
  label: UPDATE_TASKS_TITLE,
  description: UPDATE_TASKS_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<AsanaDetails>> {
    // Review-before-post gate (yes/no on a readable change summary).
    // Resolve task + parent GIDs to names + URLs so the human sees what they
    // are about to change, not bare GIDs. Skipped on the fast paths.
    const parentGids = params.tasks
      .map((t) => t.parent)
      .filter((p): p is string => !!p);
    const resolved = willPromptForWrite(ctx)
      ? await resolveTasks([...params.tasks.map((t) => t.gid), ...parentGids])
      : undefined;
    const decision = await confirmWrite(ctx, {
      title: `Update ${params.tasks.length} Asana task${
        params.tasks.length === 1 ? "" : "s"
      }?`,
      summary: summarizeUpdateTasks(params.tasks, resolved),
    });
    if (!decision.proceed) {
      return toToolResult(
        `Asana: task update cancelled by user (${params.tasks.length} task${
          params.tasks.length === 1 ? "" : "s"
        }). Nothing was changed.`,
      );
    }

    const updated: AsanaTaskCompact[] = [];
    const failures: Array<{ gid: string; error: string }> = [];

    for (const spec of params.tasks) {
      const { gid, ...rest } = spec;
      // Drop undefined keys so PUT only carries the fields the agent wanted
      // to change. Asana silently ignores unknown keys, but a clean body
      // keeps idempotent retries safe.
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) body[k] = v;
      }
      if (Object.keys(body).length === 0) {
        failures.push({
          gid,
          error:
            "no mutable fields supplied; pass at least one (e.g. completed: true).",
        });
        continue;
      }
      try {
        const task = await callAsana<AsanaTaskCompact>(
          "PUT",
          `/tasks/${encodeURIComponent(gid)}`,
          {
            query: { opt_fields: "name,completed" },
            body,
          },
        );
        updated.push(task);
      } catch (err) {
        failures.push({ gid, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const lines: string[] = [];
    lines.push(
      `Asana: ${updated.length} of ${params.tasks.length} task${params.tasks.length === 1 ? "" : "s"} updated.`,
    );
    for (const t of updated) {
      const flag = t.completed ? " [completed]" : "";
      lines.push(`- ${t.name ?? "(untitled)"} (gid: ${t.gid})${flag}`);
    }
    if (failures.length > 0) {
      lines.push("");
      lines.push(`Failures (${failures.length}):`);
      for (const f of failures) {
        lines.push(`- ${f.gid}: ${f.error}`);
      }
    }
    return toToolResult(lines.join("\n"));
  },
};
