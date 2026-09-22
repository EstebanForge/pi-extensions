import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { fieldType } from "../custom-fields";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaCustomField, AsanaTaskCompact } from "../types";
import {
  GET_CUSTOM_FIELDS_TITLE,
  GET_CUSTOM_FIELDS_DESCRIPTION,
  GET_CUSTOM_FIELDS_GID_DESCRIPTION,
} from "../prompts";

// asana_get_task returns custom_fields as a compact projection (gid/name/
// display_value only). That hides the field type and the enum option list an
// agent needs to SET a field safely. This tool asks for the full custom_fields
// projection: type, current value, gid, and enum options. Pair it with
// asana_set_custom_fields (write) and asana_get_task (everything else).
const Params = Type.Object({
  gid: Type.String({ description: GET_CUSTOM_FIELDS_GID_DESCRIPTION }),
});

// opt_fields that fully populate AsanaCustomField on a task projection. Asana
// uses dot notation for nested fields, so enum options and the current enum
// value are pulled explicitly.
const CUSTOM_FIELDS_OPT_FIELDS = [
  "name",
  "custom_fields",
  "custom_fields.name",
  "custom_fields.resource_subtype",
  "custom_fields.type",
  "custom_fields.enabled",
  "custom_fields.description",
  "custom_fields.text_value",
  "custom_fields.number_value",
  "custom_fields.enum_value",
  "custom_fields.enum_value.name",
  "custom_fields.enum_value.gid",
  "custom_fields.display_value",
  "custom_fields.enum_options",
  "custom_fields.enum_options.name",
  "custom_fields.enum_options.gid",
  "custom_fields.enum_options.enabled",
  "custom_fields.precision",
  "custom_fields.format",
  "custom_fields.currency_code",
].join(",");

function renderField(f: AsanaCustomField): string[] {
  const type = fieldType(f);
  const gid = f.gid;
  const name = f.name ?? "(unnamed)";
  const value = f.display_value ?? "(empty)";
  const lines: string[] = [];
  lines.push(`- ${name} [${type}] (gid: ${gid}): ${value}`);
  if (type === "enum") {
    const opts = (f.enum_options ?? [])
      .filter((o) => o.enabled !== false)
      .map((o) => o.name)
      .filter((n): n is string => !!n);
    if (opts.length > 0) {
      lines.push(`    options: ${opts.join(", ")}`);
    }
  }
  return lines;
}

export const getCustomFieldsTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_get_custom_fields",
  label: GET_CUSTOM_FIELDS_TITLE,
  description: GET_CUSTOM_FIELDS_DESCRIPTION,
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
          query: { opt_fields: CUSTOM_FIELDS_OPT_FIELDS },
        },
      );
      const fields = (task.custom_fields ?? []) as unknown as AsanaCustomField[];
      const lines: string[] = [];
      lines.push(
        `Task ${task.gid}${task.name ? ` (${task.name})` : ""}: ${fields.length} custom field${
          fields.length === 1 ? "" : "s"
        }`,
      );
      if (fields.length === 0) {
        lines.push("(no custom fields on this task)");
      }
      for (const f of fields) {
        lines.push(...renderField(f));
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
