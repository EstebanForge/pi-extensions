import { Text } from "@earendil-works/pi-tui";
import { registerCleanup, registerTimer } from "./disposable.js";
import { pluralize } from "./render-utils.js";

const BASH_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const BASH_SPINNER_INTERVAL_MS = 200;
const BASH_SPINNER_STATE_KEY = "__piToolDisplayBashSpinner";
const BASH_SPINNER_TOOL_CALL_ID_KEY = "__piToolDisplayBashSpinnerToolCallId";

interface BashCallArgs {
	command?: string;
	commandPrefix?: string;
	shellPath?: string;
	timeout?: number;
}

interface BashCallRenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface BashSpinnerState {
	frameIndex: number;
	startedAt?: number;
	timer?: ReturnType<typeof setInterval>;
	expanded?: boolean;
}

interface BashSpinnerStateCarrier {
	[BASH_SPINNER_STATE_KEY]?: BashSpinnerState;
	[BASH_SPINNER_TOOL_CALL_ID_KEY]?: string;
}

interface BashCallRenderContextLike {
	executionStarted: boolean;
	isPartial: boolean;
	invalidate?: () => void;
	lastComponent?: unknown;
	state?: unknown;
	toolCallId?: string;
	expanded?: boolean;
}

const spinnerStatesByToolCallId = new Map<string, BashSpinnerState>();
let nextSyntheticToolCallId = 0;

function toStateCarrier(value: unknown): BashSpinnerStateCarrier | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return value as BashSpinnerStateCarrier;
}

function getSyntheticToolCallId(carrier: BashSpinnerStateCarrier | undefined): string | undefined {
	if (!carrier) {
		return undefined;
	}

	if (!carrier[BASH_SPINNER_TOOL_CALL_ID_KEY]) {
		carrier[BASH_SPINNER_TOOL_CALL_ID_KEY] = `state:${++nextSyntheticToolCallId}`;
	}
	return carrier[BASH_SPINNER_TOOL_CALL_ID_KEY];
}

function getToolCallId(context: BashCallRenderContextLike): string | undefined {
	if (typeof context.toolCallId === "string" && context.toolCallId.trim().length > 0) {
		return context.toolCallId;
	}
	return getSyntheticToolCallId(toStateCarrier(context.state));
}

function getOrCreateSpinnerState(
	toolCallId: string | undefined,
	carrier: BashSpinnerStateCarrier | undefined,
): BashSpinnerState | undefined {
	if (!toolCallId) {
		return undefined;
	}

	let state = spinnerStatesByToolCallId.get(toolCallId);
	if (!state) {
		state = { frameIndex: 0 };
		spinnerStatesByToolCallId.set(toolCallId, state);
	}
	if (carrier) {
		carrier[BASH_SPINNER_STATE_KEY] = state;
	}
	return state;
}

function stopSpinner(toolCallId: string | undefined, state: BashSpinnerState | undefined): void {
	if (!state) {
		return;
	}

	if (state.timer) {
		clearInterval(state.timer);
		state.timer = undefined;
	}
	state.frameIndex = 0;
	state.startedAt = undefined;
	if (toolCallId) {
		spinnerStatesByToolCallId.delete(toolCallId);
	}
}

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}

	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return `${totalMinutes}m ${seconds}s`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes}m`;
}

function isDefaultShellPath(shellPath: string): boolean {
	const normalized = shellPath.trim().replace(/\\/g, "/").toLowerCase();
	const basename = normalized.split("/").pop() || normalized;
	return basename === "bash" || basename === "cmd.exe";
}

function buildCommandDisplay(args: BashCallArgs): string {
	const command =
		typeof args.command === "string" && args.command.trim().length > 0
			? args.command
			: "...";
	const prefix =
		typeof args.commandPrefix === "string" && args.commandPrefix.trim().length > 0
			? args.commandPrefix.trim()
			: "";
	return prefix ? `${prefix} ${command}` : command;
}

// renderCall never sees the pane width, so the cap is fixed instead of width-based.
const COMMAND_PREVIEW_MAX_CHARS = 160;

function collapseCommandDisplay(commandDisplay: string, theme: BashCallRenderTheme): string {
	// Trailing newlines and CRLF endings would otherwise inflate (+N) or leak a carriage return.
	const normalized = commandDisplay.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	const lines = normalized.split("\n");
	const firstLine = lines[0] ?? "";
	const cut = firstLine.length > COMMAND_PREVIEW_MAX_CHARS;
	const preview = cut ? `${firstLine.slice(0, COMMAND_PREVIEW_MAX_CHARS)}…` : firstLine;
	const hiddenLines = lines.length - 1 + (cut ? 1 : 0);
	const suffix =
		hiddenLines > 0
			? theme.fg("muted", ` (+${hiddenLines} more ${pluralize(hiddenLines, "line")} • Ctrl+O to expand)`)
			: "";
	return `${preview}${suffix}`;
}

function buildBashCallText(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	spinnerFrame?: string,
	elapsedMs?: number,
	expanded?: boolean,
): string {
	const commandDisplay = expanded
		? buildCommandDisplay(args)
		: collapseCommandDisplay(buildCommandDisplay(args), theme);
	const shellSuffix =
		typeof args.shellPath === "string" &&
		args.shellPath.trim().length > 0 &&
		!isDefaultShellPath(args.shellPath)
			? theme.fg("muted", ` [shell: ${args.shellPath}]`)
			: "";
	const timeoutSuffix = args.timeout
		? theme.fg("muted", ` (timeout ${args.timeout}s)`)
		: "";
	const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
	const elapsedSuffix =
		spinnerFrame && elapsedMs !== undefined
			? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
			: "";

	return `${spinnerPrefix}${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", commandDisplay)}${shellSuffix}${timeoutSuffix}${elapsedSuffix}`;
}

export function renderBashCall(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const carrier = toStateCarrier(context.state);
	const toolCallId = getToolCallId(context);
	const spinnerState = getOrCreateSpinnerState(toolCallId, carrier);
	const shouldSpin = context.executionStarted && context.isPartial;

	if (!shouldSpin) {
		stopSpinner(toolCallId, spinnerState);
		text.setText(buildBashCallText(args, theme, undefined, undefined, context.expanded === true));
		return text;
	}

	if (spinnerState) {
		spinnerState.startedAt ??= Date.now();
		// The timer closure outlives the render that created it, so expansion state
		// must live on the spinner state, not on the captured context.
		spinnerState.expanded = context.expanded === true;
		if (!spinnerState.timer && typeof context.invalidate === "function") {
			const timer = setInterval(() => {
				spinnerState.frameIndex = (spinnerState.frameIndex + 1) % BASH_SPINNER_FRAMES.length;
				text.setText(
					buildBashCallText(
						args,
						theme,
						BASH_SPINNER_FRAMES[spinnerState.frameIndex],
						Date.now() - (spinnerState.startedAt ?? Date.now()),
						spinnerState.expanded === true,
					),
				);
				context.invalidate?.();
			}, BASH_SPINNER_INTERVAL_MS);
			spinnerState.timer = timer;
			registerTimer(timer);
			registerCleanup(() => {
				if (spinnerStatesByToolCallId.get(toolCallId || "") === spinnerState) {
					stopSpinner(toolCallId, spinnerState);
				}
			});
		}
	}

	const spinnerFrame = spinnerState ? BASH_SPINNER_FRAMES[spinnerState.frameIndex] : undefined;
	const elapsedMs = spinnerState?.startedAt !== undefined
		? Date.now() - spinnerState.startedAt
		: undefined;
	text.setText(buildBashCallText(args, theme, spinnerFrame, elapsedMs, context.expanded === true));
	return text;
}
