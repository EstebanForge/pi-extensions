// Framed dialog primitives. Dialog pattern adapted from pi-subagent-manager
// (MIT, Copyright (c) 2026 pi-subagent contributors); see LICENSE.
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** Minimal host a dialog needs: re-render requests plus terminal rows. */
export interface DialogHost {
	requestRender(force?: boolean): void;
	terminal?: { rows: number };
}

/** Overlay options shared by every dialog: centered, near-fullscreen. */
export const DIALOG_OPTIONS = {
	overlay: true,
	overlayOptions: {
		anchor: "center",
		width: "90%",
		maxHeight: "90%",
		margin: 1,
	},
} as const;

/** Strip ANSI and control characters from untrusted row text. */
export function dialogText(text: string): string {
	return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Match Pi's overlay height calculation; maxHeight alone would clip the bottom border. */
export function dialogHeight(host: { terminal?: { rows: number } }): number {
	const rows = host.terminal?.rows ?? 24;
	return Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.9)));
}

/** Render the shared rounded frame: title in the top border, body lines, footer above the bottom border.
 *  A string-array footer picks the first variant that fits the width (RTK undertitle behavior). */
export function frameDialog(
	theme: FrameTheme,
	width: number,
	height: number,
	title: string,
	body: string[],
	footer: string | readonly string[],
): string[] {
	if (width <= 0 || height <= 0) return [];
	const fit = (text: string, columns: number) => {
		const clipped = truncateToWidth(text, Math.max(0, columns), "", true);
		return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
	};
	if (width < 4 || height < 4) {
		return [fit(theme.fg("muted", dialogText(title)), width)];
	}
	const inner = width - 2;
	const line = (text: string) => theme.fg("border", "│") + fit(text, inner) + theme.fg("border", "│");
	const footerText = pickFooterVariant(footer, inner - 3);
	const heading = truncateToWidth(` ${dialogText(title)} `, inner, "");
	const top = theme.fg("border", "╭" + heading + "─".repeat(Math.max(0, inner - visibleWidth(heading))) + "╮");
	// Pad to the full frame so centered overlays keep the same bounds between views.
	const budget = height - 4;
	const padded = body.slice(0, budget);
	while (padded.length < budget) padded.push("");
	const content = padded.map(line);
	return [
		top,
		...content,
		theme.fg("border", "├" + "─".repeat(inner) + "┤"),
		line(theme.fg("dim", dialogText(footerText))),
		theme.fg("border", "╰" + "─".repeat(inner) + "╯"),
	];
}

/** The theme color slots dialogs use, a subset of Pi's Theme fg names. */
export type FrameTheme = {
	fg(color: "border" | "muted" | "dim", text: string): string;
};

function pickFooterVariant(footer: string | readonly string[], maxWidth: number): string {
	if (typeof footer === "string") return footer;
	if (footer.length === 0) return "";
	for (const variant of footer) {
		if (visibleWidth(variant) <= maxWidth) return variant;
	}
	return footer[footer.length - 1]!;
}
