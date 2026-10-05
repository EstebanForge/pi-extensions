import { shortenPath } from "./render-utils.js";

export interface TidyTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const TIDY_TOOL_ICONS: Record<string, string> = {
	read: "📖",
	grep: "📖",
	find: "📖",
	ls: "📖",
	edit: "✏️",
	write: "✏️",
	bash: "⚡",
} as const;

const FALLBACK_ICON = "◆";

export function tidyIcon(toolName: string): string {
	return TIDY_TOOL_ICONS[toolName] ?? FALLBACK_ICON;
}

export function firstNonEmptyLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return "";
}

function getStringField(args: Record<string, unknown>, field: string): string | undefined {
	const value = args[field];
	return typeof value === "string" ? value : undefined;
}

function getNumericField(args: Record<string, unknown>, field: string): number | undefined {
	const value = args[field];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatLimitSuffix(args: Record<string, unknown>): string {
	const limit = getNumericField(args, "limit");
	return limit !== undefined ? ` limit ${limit}` : "";
}

function readDetail(args: Record<string, unknown>): string {
	const path = shortenPath(getStringField(args, "path") ?? getStringField(args, "file_path")) || "...";
	const offset = getNumericField(args, "offset");
	const limit = getNumericField(args, "limit");
	if (offset === undefined && limit === undefined) {
		return path;
	}
	const from = offset ?? 1;
	const to = limit !== undefined ? from + limit - 1 : undefined;
	return to !== undefined ? `${path}:${from}-${to}` : `${path}:${from}`;
}

function grepDetail(args: Record<string, unknown>): string {
	const pattern = getStringField(args, "pattern") ?? "...";
	const scope = shortenPath(getStringField(args, "path") || ".");
	const glob = getStringField(args, "glob");
	return `/${pattern}/ in ${scope}${glob ? ` (${glob})` : ""}${formatLimitSuffix(args)}`;
}

function findDetail(args: Record<string, unknown>): string {
	const pattern = getStringField(args, "pattern") ?? "...";
	const scope = shortenPath(getStringField(args, "path") || ".");
	return `${pattern} in ${scope}${formatLimitSuffix(args)}`;
}

function lsDetail(args: Record<string, unknown>): string {
	const scope = shortenPath(getStringField(args, "path") || ".");
	return `${scope}${formatLimitSuffix(args)}`;
}

/** Argument detail shown next to the tool name on a tidy card header. */
export function tidyToolDetail(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "read":
			return readDetail(args);
		case "grep":
			return grepDetail(args);
		case "find":
			return findDetail(args);
		case "ls":
			return lsDetail(args);
		default:
			return "";
	}
}

export function buildTidyHeaderLine(
	toolName: string,
	args: Record<string, unknown> | undefined | null,
	theme: TidyTheme,
): string {
	// Pi can invoke renderCall before arguments stream in; never assume args exist.
	const record = args && typeof args === "object" ? args : {};
	const detail = tidyToolDetail(toolName, record);
	const header = `${tidyIcon(toolName)} ${theme.fg("toolTitle", theme.bold(toolName))}`;
	return detail ? `${header} ${theme.fg("accent", detail)}` : header;
}

export interface GrepMatchCounts {
	matches: number;
	files: number;
}

/**
 * Count matches and unique source files in grep output. Files are only
 * reported when lines follow the `path:line:text` convention; plain output
 * yields `files: 0` so callers can omit the suffix.
 */
export function countGrepMatches(lines: string[]): GrepMatchCounts {
	const files = new Set<string>();
	let matches = 0;

	for (const line of lines) {
		if (!line.trim()) {
			continue;
		}
		matches++;
		// Non-greedy: content after the line number may contain more :digits: runs
		// (timestamps, ports), which a greedy .* would fold into the file name.
		const fileMatch = /^([^:\n]+):\d+:/.exec(line);
		if (fileMatch?.[1]) {
			files.add(fileMatch[1]);
		}
	}

	return { matches, files: files.size };
}

export interface DiffChangeCounts {
	added: number;
	removed: number;
}

export function countDiffChanges(diff: string): DiffChangeCounts {
	let added = 0;
	let removed = 0;

	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) {
			continue;
		}
		if (line.startsWith("+")) {
			added++;
		} else if (line.startsWith("-")) {
			removed++;
		}
	}

	return { added, removed };
}
