import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DIALOG_OPTIONS, DialogMenu, type DialogRow, type DialogTab } from "@estebanforge/pi-tui-dialogs";
import type { ToolDisplayCapabilities } from "./capabilities.js";
import { getToolDisplayConfigPath } from "./config-store.js";
import {
	detectToolDisplayPreset,
	getToolDisplayPresetConfig,
	parseToolDisplayPreset,
	TOOL_DISPLAY_PRESETS,
	type ToolDisplayPreset,
} from "./presets.js";
import { shortenPath } from "./render-utils.js";
import { type ToolDisplayConfig } from "./types.js";

interface ToolDisplayConfigController {
	getConfig(): ToolDisplayConfig;
	setConfig(next: ToolDisplayConfig, ctx: ExtensionCommandContext): void;
	getCapabilities(): ToolDisplayCapabilities;
}

const PREVIEW_LINE_VALUES = ["4", "8", "12", "20", "40"] as const;
const BASH_PREVIEW_LINE_VALUES = ["0", "5", "10", "20", "40"] as const;
const PRESET_COMMAND_HINT = TOOL_DISPLAY_PRESETS.join("|");

function toOnOff(value: boolean): string {
	return value ? "on" : "off";
}

function toolOwnershipSummary(config: ToolDisplayConfig): string {
	const overrides = config.registerToolOverrides;
	return `read:${toOnOff(overrides.read)},grep:${toOnOff(overrides.grep)},find:${toOnOff(overrides.find)},ls:${toOnOff(overrides.ls)},bash:${toOnOff(overrides.bash)},edit:${toOnOff(overrides.edit)},write:${toOnOff(overrides.write)}`;
}

function summarizeConfig(config: ToolDisplayConfig, capabilities: ToolDisplayCapabilities): string {
	const preset = detectToolDisplayPreset(config);
	const parts = [
		`preset=${preset}`,
		`cards=${toOnOff(config.tidyCards)}`,
		`hashline=${toOnOff(config.hashlineCards)}`,
		`owners={${toolOwnershipSummary(config)}}`,
		`userBox=${toOnOff(config.enableNativeUserMessageBox)}`,
		`read=${config.readOutputMode}`,
		`search=${config.searchOutputMode}`,
		`preview=${config.previewLines}`,
		`expandedMax=${config.expandedPreviewMaxLines}`,
		`bash=${config.bashOutputMode}`,
		`bashLines=${config.bashCollapsedLines}`,
		`diff=${config.diffViewMode}/${config.diffIndicatorMode}@${config.diffSplitMinWidth}`,
		`diffLines=${config.diffCollapsedLines}`,
		`diffWrap=${toOnOff(config.diffWordWrap)}`,
	];

	if (capabilities.hasMcpTooling) {
		parts.push(`mcp=${config.mcpOutputMode}`);
	} else {
		parts.push("mcp=auto-hidden");
	}

	if (capabilities.hasRtkOptimizer) {
		parts.push(`rtkHints=${toOnOff(config.showRtkCompactionHints)}`);
	} else {
		parts.push("rtkHints=auto-off");
	}

	return parts.join(", ");
}

function parseNumber(value: string, fallback: number): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

/** One flat row per configurable knob, display values from the live config.
 *  Pure apart from the config path; the dialog groups these into tabs. */
export function buildSettingRows(config: ToolDisplayConfig, capabilities: ToolDisplayCapabilities): DialogRow[] {
	const rows: DialogRow[] = [
		{
			id: "preset",
			label: "Preset profile",
			currentValue: detectToolDisplayPreset(config),
			values: [...TOOL_DISPLAY_PRESETS],
			description:
				"Overall verbosity and layout of tool output; a preset applies a coherent profile across read, search, MCP, bash, and diff settings. opencode = strict inline-only, balanced = compact summaries with counts, verbose = larger line previews and more visible bash output. custom shows automatically when manual overrides no longer match a preset. Presets reset multiple fields together, so manual JSON tuning is the right place for durable custom combinations.",
		},
		{
			id: "tidyCards",
			label: "Tidy tool cards",
			currentValue: toOnOff(config.tidyCards),
			values: ["on", "off"],
			description:
				"Renders built-in tool calls as compact two-line cards: an icon and target on the first line, a short result summary on the second. Cards stay collapsed; Ctrl+O expands to the full tool output or diff, matching Pi's native expansion. Off keeps the classic tool header and output modes while output modes, diffs, pending previews, and thinking labels stay unchanged.",
		},
		{
			id: "hashlineCards",
			label: "Hashline tool cards",
			currentValue: toOnOff(config.hashlineCards),
			values: ["on", "off"],
			description:
				"Renders pi-hashline-edit-pro tools (replace, insert, copy, move, replace_match, undo_last_change, anchor_grep, and a hashline-owned read) with the same tidy cards as the built-ins. Off keeps the hashline extension's own renderers. The cards are render-time adapters and never conflict with hashline's tool registration.",
		},
		{
			id: "enableNativeUserMessageBox",
			label: "Native user message box",
			currentValue: toOnOff(config.enableNativeUserMessageBox),
			values: ["on", "off"],
			description:
				"Bordered native renderer for user prompts inside the transcript. On = clearer message separation; off = Pi's default user message rendering. Presentation only: stored prompts, markdown handling, and tool behavior are unchanged.",
		},
		{
			id: "readOutputMode",
			label: "Read tool output",
			currentValue: config.readOutputMode,
			values: ["hidden", "summary", "preview"],
			description:
				"How read results appear inline after the tool call header: hidden = path and status only, summary = compact file metrics, preview = the first configured preview lines. Use hidden for the cleanest transcript. expandedPreviewMaxLines (manual JSON) bounds how many lines can appear after expanding a preview-heavy read result.",
		},
		{
			id: "searchOutputMode",
			label: "Grep/Find/Ls output",
			currentValue: config.searchOutputMode,
			values: ["hidden", "count", "preview"],
			description:
				"How search-style tools compress their result sets: hidden = call header only, count = totals only for matches or entries, preview = the first configured preview lines. Count keeps discovery actions readable while still surfacing how much data the tool matched.",
		},
	];

	if (capabilities.hasMcpTooling) {
		rows.push({
			id: "mcpOutputMode",
			label: "MCP tool output",
			currentValue: config.mcpOutputMode,
			values: ["hidden", "summary", "preview"],
			description:
				"How proxied MCP tool results are compacted when they return text: hidden = call metadata only, summary = compact line-count summary, preview = the first configured preview lines. Summary is the safest default when you want awareness without flooding the chat pane. This row appears only when MCP tooling is available in the session.",
		});
	}

	rows.push(
		{
			id: "previewLines",
			label: "Preview lines",
			currentValue: String(config.previewLines),
			values: [...PREVIEW_LINE_VALUES],
			description:
				"How many lines appear when read, search, MCP, or bash preview modes are collapsed inline. Manual JSON accepts 1 to 80 lines; the quick selector cycles a curated set for fast tuning. Lower keeps transcripts dense and skimmable, higher surfaces more source context before expansion.",
		},
		{
			id: "bashOutputMode",
			label: "Bash tool output",
			currentValue: config.bashOutputMode,
			values: ["opencode", "summary", "preview"],
			description:
				"How shell command output renders on success: opencode = Pi/OpenCode-style collapsed bash view, summary = output count only, preview = uses the shared previewLines setting. Quiet commands still collapse aggressively, so mode selection matters most on verbose build, test, and script output.",
		},
		{
			id: "bashCollapsedLines",
			label: "Bash collapsed lines",
			currentValue: String(config.bashCollapsedLines),
			values: [...BASH_PREVIEW_LINE_VALUES],
			description:
				"Inline line budget used by opencode bash mode before expansion. Manual JSON accepts 0 to 80; 0 hides collapsed bash output entirely while keeping the command visible. Preview mode continues to use previewLines instead.",
		},
		{
			id: "diffViewMode",
			label: "Edit diff layout",
			currentValue: config.diffViewMode,
			values: ["auto", "split", "unified"],
			description:
				"How edit and write diffs are arranged: auto = adaptive layout based on terminal width so wide panes get side-by-side columns, split = forced side-by-side, unified = forced single column. Manual JSON exposes diffSplitMinWidth, diffCollapsedLines, diffIndicatorMode, and diffWordWrap for finer control.",
		},
		{
			id: "diffIndicatorMode",
			label: "Diff indicators",
			currentValue: config.diffIndicatorMode,
			values: ["bars", "classic", "none"],
			description:
				"Whether changed diff lines use vertical bars, classic +/- markers, or no indicators. Bars continue across wrapped changed rows, classic markers appear only on the first wrapped row, and none removes the indicator column styling.",
		},
		{
			id: "allowExternalDiffPreviews",
			label: "External diff previews",
			currentValue: toOnOff(config.allowExternalDiffPreviews),
			values: ["off", "on"],
			description:
				"Edit and write diff previews for target files located outside the active workspace. Off restricts previews to workspace paths; on allows target paths anywhere on disk. Affects presentation previews rendered by pi-tool-display only.",
		},
	);

	return rows;
}

/** Rows grouped for the dialog: left/right switches tabs. The MCP row only
 *  exists when MCP tooling is present, so groups are built per open. */
function buildSettingTabs(config: ToolDisplayConfig, capabilities: ToolDisplayCapabilities): DialogTab[] {
	const byId = new Map(buildSettingRows(config, capabilities).map((row) => [row.id, row]));
	const pick = (...ids: string[]): DialogRow[] =>
		ids.map((id) => byId.get(id)).filter((row): row is DialogRow => row !== undefined);

	const tabs: DialogTab[] = [
		{ label: "Layout", rows: pick("preset", "tidyCards", "hashlineCards", "enableNativeUserMessageBox") },
		{
			label: "Output",
			rows: pick(
				"readOutputMode",
				"searchOutputMode",
				"mcpOutputMode",
				"previewLines",
				"bashOutputMode",
				"bashCollapsedLines",
			),
		},
		{ label: "Diffs", rows: pick("diffViewMode", "diffIndicatorMode", "allowExternalDiffPreviews") },
	];
	return tabs.filter((tab) => tab.rows.length > 0);
}

function applyPreset(preset: ToolDisplayPreset): ToolDisplayConfig {
	return getToolDisplayPresetConfig(preset);
}

function applySetting(config: ToolDisplayConfig, id: string, value: string): ToolDisplayConfig {
	switch (id) {
		case "preset": {
			const parsed = parseToolDisplayPreset(value);
			return parsed ? applyPreset(parsed) : config;
		}
		case "tidyCards":
			return {
				...config,
				tidyCards: value === "on",
			};
		case "hashlineCards":
			return {
				...config,
				hashlineCards: value === "on",
			};
		case "enableNativeUserMessageBox":
			return {
				...config,
				enableNativeUserMessageBox: value === "on",
			};
		case "readOutputMode":
			return {
				...config,
				readOutputMode: value as ToolDisplayConfig["readOutputMode"],
			};
		case "searchOutputMode":
			return {
				...config,
				searchOutputMode: value as ToolDisplayConfig["searchOutputMode"],
			};
		case "mcpOutputMode":
			return {
				...config,
				mcpOutputMode: value as ToolDisplayConfig["mcpOutputMode"],
			};
		case "previewLines":
			return {
				...config,
				previewLines: parseNumber(value, config.previewLines),
			};
		case "bashOutputMode":
			return {
				...config,
				bashOutputMode: value as ToolDisplayConfig["bashOutputMode"],
			};
		case "bashCollapsedLines":
			return {
				...config,
				bashCollapsedLines: parseNumber(value, config.bashCollapsedLines),
			};
		case "diffViewMode":
			return {
				...config,
				diffViewMode: value as ToolDisplayConfig["diffViewMode"],
			};
		case "diffIndicatorMode":
			return {
				...config,
				diffIndicatorMode: value as ToolDisplayConfig["diffIndicatorMode"],
			};
		case "allowExternalDiffPreviews":
			return {
				...config,
				allowExternalDiffPreviews: value === "on",
			};
		default:
			return config;
	}
}

export async function openSettingsModal(ctx: ExtensionCommandContext, controller: ToolDisplayConfigController): Promise<void> {
	const capabilities = controller.getCapabilities();

	await ctx.ui.custom<void>(
		(host, theme, _keybindings, done) => {
			const menu = new DialogMenu(
				host,
				theme,
				{
					title: "Pi Tool Display settings",
					subtitle: `Config file: ${shortenPath(getToolDisplayConfigPath())} — changes apply immediately`,
					tabs: buildSettingTabs(controller.getConfig(), capabilities),
					footer: "↑↓ navigate · Enter/Space cycle · ←→ tabs · Type to search · Esc close",
					onChange: (id, newValue) => {
						const next = applySetting(controller.getConfig(), id, newValue);
						controller.setConfig(next, ctx);
						// A preset swap rewrites several fields at once; re-sync every
						// row's display from the fresh config, not just the cycled one.
						for (const row of buildSettingRows(next, capabilities)) {
							menu.updateValue(row.id, row.currentValue);
						}
						host.requestRender();
					},
				},
				() => done(),
			);

			return {
				render: (width: number) => menu.render(width),
				invalidate: () => menu.invalidate(),
				handleInput(data: string) {
					menu.handleInput(data);
					host.requestRender();
				},
			};
		},
		DIALOG_OPTIONS,
	);
}

export function handleToolDisplayArgs(args: string, ctx: ExtensionCommandContext, controller: ToolDisplayConfigController): boolean {
	const raw = args.trim();
	if (!raw) {
		return false;
	}

	const normalized = raw.toLowerCase();

	if (normalized === "show") {
		ctx.ui.notify(
			`tool-display: ${summarizeConfig(controller.getConfig(), controller.getCapabilities())}`,
			"info",
		);
		return true;
	}

	if (normalized === "reset") {
		controller.setConfig(getToolDisplayPresetConfig("opencode"), ctx);
		ctx.ui.notify("Tool display preset reset to opencode.", "info");
		return true;
	}

	if (normalized.startsWith("preset ")) {
		const candidate = normalized.slice("preset ".length).trim();
		const preset = parseToolDisplayPreset(candidate);
		if (!preset) {
			ctx.ui.notify(`Unknown preset. Use: /tool-display preset ${PRESET_COMMAND_HINT}`, "warning");
			return true;
		}

		controller.setConfig(getToolDisplayPresetConfig(preset), ctx);
		ctx.ui.notify(`Tool display preset set to ${preset}.`, "info");
		return true;
	}

	ctx.ui.notify(`Usage: /tool-display [show|reset|preset ${PRESET_COMMAND_HINT}]`, "warning");
	return true;
}

export async function runToolDisplayCommandHandler(
	args: string,
	ctx: ExtensionCommandContext,
	controller: ToolDisplayConfigController,
): Promise<void> {
	if (handleToolDisplayArgs(args, ctx, controller)) {
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify("/tool-display requires interactive TUI mode.", "warning");
		return;
	}

	await openSettingsModal(ctx, controller);
}

export function registerToolDisplayCommand(pi: ExtensionAPI, controller: ToolDisplayConfigController): void {
	pi.registerCommand("tool-display", {
		description: "Configure tool output rendering (OpenCode-style)",
		handler: async (args, ctx) => {
			await runToolDisplayCommandHandler(args, ctx, controller);
		},
	});
}
