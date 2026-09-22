// Shared helpers for the custom-fields tools (get + set). Lives here rather
// than duplicated in each tool so a type-string normalization change only has
// to be made once.

import type { AsanaCustomField } from "./types";

// Normalized field type string. Asana exposes both `resource_subtype` and
// `type` on a task's custom_fields projection; both carry "text" | "number" |
// "enum" (plus date / people / multi_enum / formula). Prefer resource_subtype,
// fall back to type, default to "text" when both are absent.
export function fieldType(f: AsanaCustomField): string {
  return f.resource_subtype ?? f.type ?? "text";
}
