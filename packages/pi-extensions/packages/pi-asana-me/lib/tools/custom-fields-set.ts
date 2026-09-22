import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { confirmWrite } from "../confirm";
import { fieldType } from "../custom-fields";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaCustomField, AsanaTaskCompact } from "../types";
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
// review dialog as the other write tools.
// permalink_url rides on this same GET so the confirm dialog can show a
// clickable task link (no extra round-trip, unlike comment-add's resolve).
const CUSTOM_FIELDS_OPT_FIELDS = [
  "name",
  "permalink_url",
  "custom_fields",
  "custom_fields.name",
  "custom_fields.resource_subtype",
  "custom_fields.type",
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
].join(",");

const FieldValue = Type.Union([Type.String(), Type.Number(), Type.Null()]);

const Params = Type.Object({
  task_gid: Type.String({ description: SET_CUSTOM_FIELDS_TASK_GID_DESCRIPTION }),
  fields: Type.Record(Type.String(), FieldValue, {
    description: SET_CUSTOM_FIELDS_FIELDS_DESCRIPTION,
  }),
});

interface ResolvedField {
  name: string;
  gid: string;
  type: string;
  // Value to send in the PUT custom_fields body. Enum -> option gid;
  // text -> string; number -> number; null clears any type.
  sendValue: string | number | null;
  // Human rendering of what the agent asked for, for the confirm summary.
  summary: string;
}

type FieldResult = { ok: true; field: ResolvedField } | { ok: false; error: string };

// Resolve a field key (gid or name) to a single AsanaCustomField. GID lookup
// is unambiguous and wins. A multi-project task can carry the SAME field NAME
// from two different projects (distinct gids); silently picking the first
// would write to the wrong field, so an ambiguous name is refused and the
// agent is told to key by gid. Exact name beats case-insensitive.
function findField(
  key: string,
  fields: AsanaCustomField[],
): { ok: true; field: AsanaCustomField } | { ok: false; error: string } {
  const byGid = fields.find((f) => f.gid === key);
  if (byGid) return { ok: true, field: byGid };

  const lower = key.toLowerCase();
  const exact = fields.filter((f) => f.name === key);
  const ci = fields.filter((f) => !!f.name && f.name.toLowerCase() === lower);
  const matches = exact.length > 0 ? exact : ci;
  if (matches.length === 0) {
    return { ok: false, error: `no custom field named "${key}" on this task` };
  }
  if (matches.length > 1) {
    const gids = matches.map((f) => f.gid).join(", ");
    return {
      ok: false,
      error: `"${key}" is ambiguous: ${matches.length} fields share that name (gids: ${gids}). Set it by gid instead.`,
    };
  }
  const field = matches[0];
  if (!field.gid) {
    return { ok: false, error: `no custom field named "${key}" on this task` };
  }
  return { ok: true, field };
}

// Coerce an agent-supplied value into the PUT body value for a resolved field.
// Disabled enum options are excluded from BOTH matching and the error list so
// a disabled choice can never be set and the two paths stay consistent.
function coerceValue(field: AsanaCustomField, value: string | number | null): FieldResult {
  const type = fieldType(field);
  const name = field.name ?? field.gid;
  const gid = field.gid;

  // null clears any field type.
  if (value === null) {
    return {
      ok: true, field: { name, gid, type, sendValue: null, summary: `${name} = (clear)` } };
  }

  if (type === "enum") {
    if (value === "") {
      return {
        ok: true, field: { name, gid, type, sendValue: null, summary: `${name} = (clear)` } };
    }
    const wanted = String(value);
    const options = (field.enum_options ?? []).filter((o) => o.enabled !== false);
    const match =
      options.find((o) => o.name === wanted) ??
      options.find((o) => o.name && o.name.toLowerCase() === wanted.toLowerCase());
    if (!match || !match.gid) {
      const available = options.map((o) => o.name).filter((n): n is string => !!n);
      return {
        ok: false,
        error:
          available.length > 0
            ? `"${wanted}" is not a valid option for ${name}. Options: ${available.join(", ")}`
            : `"${wanted}" is not a valid option for ${name} (no options defined)`,
      };
    }
    return {
      ok: true, field: { name, gid, type, sendValue: match.gid, summary: `${name} = ${match.name}` } };
  }

  if (type === "number") {
    let num: number;
    if (typeof value === "number") {
      num = value;
    } else {
      // Reject empty/whitespace: Number("") and Number("   ") are 0, not NaN,
      // so the NaN guard below would silently write 0. null clears a field;
      // "" is a typo or an empty LLM value, never a deliberate 0.
      const trimmed = value.trim();
      if (trimmed === "") {
        return {
          ok: false,
          error: `${name} is a number field; pass null to clear it (empty string is not allowed)`,
        };
      }
      num = Number(trimmed);
      if (Number.isNaN(num)) {
        return { ok: false, error: `${name} is a number field; "${value}" is not numeric` };
      }
    }
    return {
      ok: true, field: { name, gid, type, sendValue: num, summary: `${name} = ${num}` } };
  }

  if (type === "text") {
    return {
      ok: true,
      field: {
        name,
        gid,
        type,
        sendValue: String(value),
        summary: `${name} = ${String(value)}`,
      },
    };
  }

  // Unsupported field types: date (ISO string), people (user array),
  // multi_enum (option-gid array), formula (read-only computed), and anything
  // Asana adds later. These need body shapes this tool does not build, so
  // reject explicitly instead of letting them fall through to String(value)
  // and surface as an opaque Asana 400.
  return {
    ok: false,
    error: `${name} is a "${type}" custom field. asana_set_custom_fields supports text, number, and enum; use a different method for "${type}".`,
  };
}

function resolveField(
  key: string,
  value: string | number | null,
  fields: AsanaCustomField[],
): FieldResult {
  const found = findField(key, fields);
  if (!found.ok) return found;
  return coerceValue(found.field, value);
}

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
