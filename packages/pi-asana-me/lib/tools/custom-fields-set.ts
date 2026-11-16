import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { confirmWrite } from "../confirm";
import {
  CUSTOM_FIELDS_OPT_FIELDS,
  resolveField,
  type ResolvedField,
} from "../custom-fields";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaTaskCompact, AsanaCustomField } from "../types";
import {
  SET_CUSTOM_FIELDS_TITLE,
  SET_CUSTOM_FIELDS_DESCRIPTION,
  SET_CUSTOM_FIELDS_TASK_GID_DESCRIPTION,
  SET_CUSTOM_FIELDS_FIELDS_DESCRIPTION,
} from "../prompts";

// Set custom fields on a task by NAME (or gid). asana_update_tasks deliberately
// leaves custom_fields to this tool: enum fields need option-name -> gid
// resolution, number fields need coercion, and the agent benefits from a
// discovery read (asana_get_custom_fields) before writing. Gated by the same
// review dialog as the other write tools. The shared resolver lives in
// lib/custom-fields.ts so the batch tool runs the exact same resolution.
// permalink_url rides on this same GET so the confirm dialog can show a
// clickable task link (no extra round-trip, unlike comment-add's resolve).

const FieldValue = Type.Union([Type.String(), Type.Number(), Type.Null()]);

const Params = Type.Object({
  task_gid: Type.String({ description: SET_CUSTOM_FIELDS_TASK_GID_DESCRIPTION }),
  fields: Type.Record(Type.String(), FieldValue, {
    description: SET_CUSTOM_FIELDS_FIELDS_DESCRIPTION,
  }),
});

export const setCustomFieldsTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_set_custom_fields",
  label: SET_CUSTOM_FIELDS_TITLE,
  description: SET_CUSTOM_FIELDS_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<AsanaDetails>> {
    const entries = Object.entries(params.fields);
    if (entries.length === 0) {
      return toToolResult(
        "Asana: no fields supplied to asana_set_custom_fields. Pass at least one {name: value}.",
      );
    }

    // Fetch the task once: name for the summary + the custom_fields projection
    // to resolve names -> gids and enum values -> option gids.
    let task: AsanaTaskCompact;
    try {
      task = await callAsana<AsanaTaskCompact>(
        "GET",
        `/tasks/${encodeURIComponent(params.task_gid)}`,
        { query: { opt_fields: CUSTOM_FIELDS_OPT_FIELDS } },
      );
    } catch (err) {
      if (err instanceof AsanaError && err.status === 404) {
        return toToolResult(
          `Asana: task ${params.task_gid} not found. Verify the GID with \`asana_search_objects\` (resource_type=task).`,
        );
      }
      return toToolResult(errorText(err));
    }

    const fields = (task.custom_fields ?? []) as unknown as AsanaCustomField[];
    const resolved: ResolvedField[] = [];
    const errors: string[] = [];
    for (const [key, value] of entries) {
      const result = resolveField(key, value, fields);
      if (result.ok) resolved.push(result.field);
      else errors.push(`${key}: ${result.error}`);
    }
    if (errors.length > 0) {
      return toToolResult(
        `Asana: aborted set_custom_fields on ${task.name ?? params.task_gid}; fix these and retry:\n` +
          errors.map((e) => `- ${e}`).join("\n"),
      );
    }

    // Review-before-write gate (yes/no on a readable summary). The task line
    // carries the clickable permalink when present so the human can verify the
    // target, not just the GID.
    const summaryLines = resolved.map((r) => `  ${r.summary}`);
    const taskLine = task.permalink_url
      ? `task: ${task.name ?? "(untitled)"} (${params.task_gid}) ${task.permalink_url}`
      : `task: ${task.name ?? "(untitled)"} (${params.task_gid})`;
    const decision = await confirmWrite(ctx, {
      title: `Set ${resolved.length} custom field${
        resolved.length === 1 ? "" : "s"
      } on ${task.name ?? params.task_gid}?`,
      summary: [taskLine, ...summaryLines].join("\n"),
    });
    if (!decision.proceed) {
      return toToolResult(
        `Asana: set_custom_fields cancelled by user (${resolved.length} field${
          resolved.length === 1 ? "" : "s"
        }). Nothing was changed.`,
      );
    }

    const body: Record<string, unknown> = {};
    for (const r of resolved) {
      body[r.gid] = r.sendValue;
    }
    try {
      const updated = await callAsana<AsanaTaskCompact>(
        "PUT",
        `/tasks/${encodeURIComponent(params.task_gid)}`,
        {
          query: {
            opt_fields:
              "name,custom_fields.name,custom_fields.display_value,custom_fields.gid",
          },
          body: { custom_fields: body },
        },
      );
      // Echo the new display_value per field the agent set.
      const after = (updated.custom_fields ?? []) as unknown as AsanaCustomField[];
      const byGid = new Map(after.map((f) => [f.gid, f]));
      const lines: string[] = [
        `Asana: set ${resolved.length} custom field${
          resolved.length === 1 ? "" : "s"
        } on ${updated.name ?? params.task_gid}.`,
      ];
      for (const r of resolved) {
        const now = byGid.get(r.gid);
        lines.push(`- ${r.name} = ${now?.display_value ?? "(empty)"}`);
      }
      return toToolResult(lines.join("\n"));
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
