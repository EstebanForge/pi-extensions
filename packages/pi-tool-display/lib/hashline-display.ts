import { Text } from "@earendil-works/pi-tui";
import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { renderEditDiffResult } from "./diff-renderer.js";
import {
  countDiffChanges,
  countGrepMatches,
  firstNonEmptyLine,
  tidyIcon,
  type TidyTheme,
} from "./tidy-cards.js";
import {
  extractTextOutput,
  pluralize,
  sanitizeAnsiForThemedOutput,
  shortenPath,
  splitLines,
} from "./render-utils.js";
import {
  getBuiltInDisplayRenderers,
  type RenderTheme,
} from "./tool-overrides.js";
import type { ToolDisplayConfig } from "./types.js";

// Display adapters for YuGiMob/pi-hashline-edit-pro tools. The extension
// replaces `read` and registers `replace`, `insert`, and friends on its own
// ExtensionAPI object, so the registration-time decoration paths never see
// them. The ToolExecutionComponent patch resolves these adapters by tool name
// at render time instead, overriding the foreign renderers with the same tidy
// cards the built-ins get. All field reads are structural: the upstream
// details shapes may evolve without breaking this module.

export const HASHLINE_TOOL_NAMES = [
  "replace",
  "replace_match",
  "insert",
  "copy",
  "move",
  "undo_last_change",
  "anchor_grep",
  "read",
] as const;

const EDIT_FAMILY_TOOLS = new Set<string>([
  "replace",
  "replace_match",
  "insert",
  "copy",
  "move",
  "undo_last_change",
]);

export interface HashlineDisplayRenderers {
  renderCall: (args: Record<string, unknown>, theme: RenderTheme, context?: unknown) => unknown;
  renderResult: (
    result: unknown,
    options: ToolRenderResultOptions,
    theme: RenderTheme,
    context?: unknown,
  ) => unknown;
}

type ConfigGetter = () => ToolDisplayConfig;

interface HashlineToolResult {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

interface HashlineEditDetails {
  diff?: unknown;
  classification?: unknown;
  batch?: { id?: unknown; size?: unknown; last?: unknown };
  warnings?: unknown;
  hints?: unknown;
}

function getStringField(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getNumericField(args: Record<string, unknown>, field: string): number | undefined {
  const value = args[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textResult(text: string): Text {
  return new Text(text, 0, 0);
}

function tidyResultLine(theme: RenderTheme, body: string): string {
  return `${theme.fg("muted", "  →")} ${body}`;
}

function shortAnchor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > 6 ? `${value.slice(0, 6)}…` : value;
}

function countChangeEntries(args: Record<string, unknown>): number {
  const changes = args.changes;
  return Array.isArray(changes) ? changes.length : 0;
}

function anchorFallbackDetail(args: Record<string, unknown>): string {
  const anchor = shortAnchor(
    getStringField(args, "remove_from") ?? getStringField(args, "anchor"),
  );
  return anchor ?? "...";
}

function replaceMatchDetail(args: Record<string, unknown>): string {
  const pattern = getStringField(args, "pattern");
  const scope = shortenPath(getStringField(args, "path") || ".");
  if (!pattern) {
    return shortenPath(getStringField(args, "path")) || anchorFallbackDetail(args);
  }
  return `/${pattern}/ in ${scope}`;
}

function anchorGrepDetail(args: Record<string, unknown>): string {
  const pattern = getStringField(args, "pattern") ?? "...";
  const scope = shortenPath(getStringField(args, "path") || ".");
  const glob = getStringField(args, "glob");
  const limit = getNumericField(args, "limit");
  return `/${pattern}/ in ${scope}${glob ? ` (${glob})` : ""}${limit !== undefined ? ` limit ${limit}` : ""}`;
}

function hashlineCallDetail(toolName: string, args: Record<string, unknown>): string {
  const path = shortenPath(getStringField(args, "path"));
  switch (toolName) {
    case "undo_last_change":
      return path || "...";
    case "copy":
    case "move":
      return path ? `→ ${path}` : "...";
    case "replace": {
      let detail = path || anchorFallbackDetail(args);
      const edits = countChangeEntries(args);
      if (edits > 1) {
        detail += ` (${edits} edits)`;
      }
      return detail;
    }
    case "replace_match":
      return replaceMatchDetail(args);
    case "anchor_grep":
      return anchorGrepDetail(args);
    default:
      return path || "...";
  }
}

function renderHashlineCall(
  toolName: string,
  args: Record<string, unknown> | undefined | null,
  theme: RenderTheme,
): Text {
  // Pi can invoke renderCall before arguments stream in; never assume args exist.
  const record = args && typeof args === "object" ? args : {};
  const detail = hashlineCallDetail(toolName, record);
  const header = `${tidyIcon(toolName)} ${theme.fg("toolTitle", theme.bold(toolName))}`;
  return textResult(detail ? `${header} ${theme.fg("accent", detail)}` : header);
}

function isToolError(result: HashlineToolResult, context: unknown): boolean {
  const contextRecord = toRecord(context);
  return toRecord(result).isError === true || contextRecord.isError === true;
}

function getWarningsSuffix(details: HashlineEditDetails, theme: RenderTheme): string {
  const warnings = Array.isArray(details.warnings) ? details.warnings.length : 0;
  const hints = Array.isArray(details.hints) ? details.hints.length : 0;
  let suffix = "";
  if (warnings > 0) {
    suffix += ` • ${theme.fg("warning", `${warnings} ${pluralize(warnings, "warning")}`)}`;
  }
  if (hints > 0) {
    suffix += ` • ${theme.fg("muted", `${hints} ${pluralize(hints, "hint")}`)}`;
  }
  return suffix;
}

function getBatchSuffix(details: HashlineEditDetails, theme: RenderTheme): string {
  const batch = toRecord(details.batch);
  if (batch.last !== false) {
    return "";
  }
  const id = getNumericField(batch, "id");
  const size = getNumericField(batch, "size");
  const label = id !== undefined ? `batch ${id}` : "batch";
  const total = size !== undefined ? ` (${size} ${pluralize(size, "edit")})` : "";
  return ` • ${theme.fg("warning", `${label} queued${total}`)}`;
}

function renderEditFamilyResult(
  result: HashlineToolResult,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  context: unknown,
  args: Record<string, unknown>,
): unknown {
  if (options.isPartial) {
    return textResult(theme.fg("warning", "editing..."));
  }

  const rawOutput = extractTextOutput(toRecord(result));
  if (isToolError(result, context)) {
    const firstLine = firstNonEmptyLine(rawOutput);
    const body = firstLine ? `failed: ${sanitizeAnsiForThemedOutput(firstLine)}` : "failed";
    return textResult(tidyResultLine(theme, theme.fg("error", body)));
  }

  const details = toRecord(result.details) as HashlineEditDetails;
  if (options.expanded) {
    return renderEditDiffResult(
      details,
      { expanded: true, filePath: getStringField(args, "path") },
      config,
      theme,
      rawOutput,
    );
  }

  const diff = typeof details.diff === "string" ? details.diff : "";
  let body: string;
  if (diff.trim()) {
    const { added, removed } = countDiffChanges(diff);
    body = `${theme.fg("success", `+${added}`)}${theme.fg("error", `/-${removed}`)}`;
  } else if (details.classification === "noop") {
    body = theme.fg("muted", "no changes");
  } else {
    body = theme.fg("muted", "applied");
  }
  return textResult(
    tidyResultLine(theme, body + getBatchSuffix(details, theme) + getWarningsSuffix(details, theme)),
  );
}

function renderGrepFamilyResult(
  result: HashlineToolResult,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  context: unknown,
): unknown {
  if (options.isPartial) {
    return textResult(theme.fg("warning", "searching..."));
  }

  const rawOutput = extractTextOutput(toRecord(result));
  if (isToolError(result, context)) {
    const firstLine = firstNonEmptyLine(rawOutput);
    const body = firstLine ? `failed: ${sanitizeAnsiForThemedOutput(firstLine)}` : "failed";
    return textResult(tidyResultLine(theme, theme.fg("error", body)));
  }

  const lines = splitLines(rawOutput).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return textResult(tidyResultLine(theme, theme.fg("muted", "(no output)")));
  }

  if (options.expanded) {
    const text = lines
      .slice(0, config.expandedPreviewMaxLines)
      .map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)))
      .join("\n");
    return textResult(text);
  }

  const { matches, files } = countGrepMatches(lines);
  let body: string;
  if (matches > 0) {
    body = theme.fg("success", `${matches} ${pluralize(matches, "match", "matches")}`);
    if (files > 0) {
      body += theme.fg("success", ` in ${files} ${pluralize(files, "file")}`);
    }
  } else {
    body = theme.fg("success", `${lines.length} ${pluralize(lines.length, "line")}`);
  }
  return textResult(tidyResultLine(theme, body));
}

export function getHashlineDisplayRenderers(
  toolName: string,
  getConfig: ConfigGetter,
): HashlineDisplayRenderers | undefined {
  if (!(HASHLINE_TOOL_NAMES as readonly string[]).includes(toolName)) {
    return undefined;
  }
  if (!getConfig().hashlineCards) {
    return undefined;
  }

  if (toolName === "read") {
    // Hashline's read output is line text with anchor prefixes, so the
    // built-in read card applies as-is (path header, line-count summary,
    // configured output mode).
    return getBuiltInDisplayRenderers("read", getConfig) as HashlineDisplayRenderers | undefined;
  }

  if (toolName === "anchor_grep") {
    return {
      renderCall: (args, theme) => renderHashlineCall("anchor_grep", args, theme),
      renderResult: (result, options, theme, context) =>
        renderGrepFamilyResult(result as HashlineToolResult, options, getConfig(), theme, context),
    };
  }

  if (EDIT_FAMILY_TOOLS.has(toolName)) {
    return {
      renderCall: (args, theme) => renderHashlineCall(toolName, args, theme),
      renderResult: (result, options, theme, context) =>
        renderEditFamilyResult(
          result as HashlineToolResult,
          options,
          getConfig(),
          theme,
          context,
          toRecord((context as { args?: unknown } | undefined)?.args),
        ),
    };
  }

  return undefined;
}

// TidyTheme and RenderTheme are structurally identical today; the alias keeps
// the import meaningful if either drifts.
export type HashlineTheme = RenderTheme & TidyTheme;
