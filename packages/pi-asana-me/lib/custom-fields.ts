// Shared helpers for the custom-fields tools (get + set + batch). Lives here
// rather than duplicated in each tool so a type-string normalization change
// only has to be made once.

import type { AsanaCustomField } from "./types";

// Normalized field type string. Asana exposes both `resource_subtype` and
// `type` on a task's custom_fields projection; both carry "text" | "number" |
// "enum" (plus date / people / multi_enum / formula). Prefer resource_subtype,
// fall back to type, default to "text" when both are absent.
export function fieldType(f: AsanaCustomField): string {
  return f.resource_subtype ?? f.type ?? "text";
}

// opt_fields that fully populate AsanaCustomField on a task projection. Asana
// uses dot notation for nested fields, so enum options and the current enum
// value are pulled explicitly. Shared by set + batch; batch additionally asks
// for permalink_url so its table can link each task.
export const CUSTOM_FIELDS_OPT_FIELDS = [
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

export interface ResolvedField {
  name: string;
  gid: string;
  type: string;
  // Value to send in the PUT custom_fields body. Enum -> option gid;
  // text -> string; number -> number; null clears any type.
  sendValue: string | number | null;
  // Human rendering of what the agent asked for, for the confirm summary.
  summary: string;
}

export type FieldResult = { ok: true; field: ResolvedField } | { ok: false; error: string };

// Resolve a field key (gid or name) to a single AsanaCustomField. GID lookup
// is unambiguous and wins. A multi-project task can carry the SAME field NAME
// from two different projects (distinct gids); silently picking the first
// would write to the wrong field, so an ambiguous name is refused and the
// agent is told to key by gid. Exact name beats case-insensitive.
export function findField(
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
export function coerceValue(field: AsanaCustomField, value: string | number | null): FieldResult {
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

export function resolveField(
  key: string,
  value: string | number | null,
  fields: AsanaCustomField[],
): FieldResult {
  const found = findField(key, fields);
  if (!found.ok) return found;
  return coerceValue(found.field, value);
}
