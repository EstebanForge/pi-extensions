// Kitty-graphics transcript renderer for pi-image-inline.
//
// Outside tmux, pi-tui's Image component already renders kitty graphics with
// a text fallback, so the wiring uses it directly. Inside tmux (and herdr
// panes, which nest tmux-style DCS handling), pi-tui disables images, so this
// module renders them itself using the kitty graphics protocol's Unicode
// placeholders: the image transfer is wrapped in tmux DCS passthrough and the
// visible cells are ordinary text, so tmux can scroll and redraw them like
// any other line.
//
// Requirements for the tmux path: tmux 3.3+ with `set -g allow-passthrough
// on`, and a terminal implementing Unicode placeholders (kitty >= 0.28,
// Ghostty). Ported from jnsahaj/pi-agent-browser-screenshot (MIT), which is
// proven against this exact stack (Ghostty over ssh, herdr panes).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	Container,
	getCellDimensions,
	getImageDimensions,
	Image,
	Text,
	type Component,
	type ImageDimensions,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export const IMAGE_PLACEHOLDER = "\u{10eeee}";
export const MAX_WIDTH_CELLS = 100;
export const MAX_HEIGHT_CELLS = 30;

// The graphics protocol requires chunks of at most 4096 bytes, and every
// chunk except the last must be a multiple of 4 bytes long.
const KITTY_CHUNK_SIZE = 4096;

// tmux can drop passthrough sequences written while it is busy redrawing, so
// the transfer is re-sent a couple of times. Re-sending an id the terminal
// already has is harmless.
const KITTY_RETRY_DELAYS_MS = [100, 500];

const IMAGE_CACHE_MAX = 50;

// Kitty's canonical row/column diacritics (rowcolumn-diacritics.txt from the
// protocol spec). Only the first 101 are needed because captures are capped
// at 100x30 terminal cells.
const NUMBER_TO_DIACRITIC = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346,
	0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363,
	0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c,
	0x036d, 0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592,
	0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059c, 0x059d, 0x059e,
	0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4,
	0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657,
	0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6, 0x06d7, 0x06d8,
	0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2, 0x06e4,
	0x06e7, 0x06e8, 0x06eb, 0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736,
	0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747, 0x0749,
	0x074a, 0x07eb,
].map((codePoint) => String.fromCodePoint(codePoint));

/**
 * Derive a stable 24-bit image id from the cache key. Placeholder cells
 * carry the id in their 24-bit foreground color, which is why ids are
 * capped at 24 bits: no third diacritic is needed.
 */
export function makeImageId(key: string): number {
	const bytes = createHash("sha256").update(key).digest();
	const red = bytes[0] || 1;
	const green = bytes[1] || 1;
	const blue = bytes[2] || 1;
	return (red << 16) | (green << 8) | blue;
}

export function wrapTmuxPassthrough(sequence: string): string {
	return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/**
 * Transmit a PNG (f=100) and create a virtual placement (U=1) of the given
 * cell size, quietly (q=2), chunked per the protocol.
 */
export function encodeVirtualPlacement(
	base64: string,
	imageId: number,
	columns: number,
	rows: number,
): string {
	let result = "";
	for (let offset = 0; offset < base64.length; offset += KITTY_CHUNK_SIZE) {
		const data = base64.slice(offset, offset + KITTY_CHUNK_SIZE);
		const more = offset + KITTY_CHUNK_SIZE < base64.length ? 1 : 0;
		let control = `m=${more}`;
		if (offset === 0) {
			control = `a=T,f=100,U=1,i=${imageId},c=${columns},r=${rows},q=2,${control}`;
		}
		result += wrapTmuxPassthrough(`\x1b_G${control};${data}\x1b\\`);
	}
	return result;
}

export function calculateImageCellSize(
	imageDimensions: ImageDimensions,
	maxWidthCells: number,
	maxHeightCells: number,
	cellDimensions: { widthPx: number; heightPx: number },
): { columns: number; rows: number } {
	const maxWidth = Math.max(1, Math.floor(maxWidthCells));
	const maxHeight = Math.max(1, Math.floor(maxHeightCells));
	const imageWidth = Math.max(1, imageDimensions.widthPx);
	const imageHeight = Math.max(1, imageDimensions.heightPx);
	const widthScale = (maxWidth * cellDimensions.widthPx) / imageWidth;
	const heightScale = (maxHeight * cellDimensions.heightPx) / imageHeight;
	const scale = Math.min(widthScale, heightScale);
	const columns = Math.ceil((imageWidth * scale) / cellDimensions.widthPx);
	const rows = Math.ceil((imageHeight * scale) / cellDimensions.heightPx);
	return {
		columns: Math.max(1, Math.min(maxWidth, columns)),
		rows: Math.max(1, Math.min(maxHeight, rows)),
	};
}

function isInsideTmux(): boolean {
	return Boolean(process.env.TMUX) || (process.env.TERM ?? "").startsWith("tmux");
}

// Unicode placeholders are implemented by kitty (>= 0.28) and Ghostty.
// Inside tmux, TERM is rewritten, but the outer terminal's own environment
// variables are inherited from the client that started the tmux server.
function supportsUnicodePlaceholders(): boolean {
	if (process.env.KITTY_WINDOW_ID || process.env.GHOSTTY_RESOURCES_DIR) {
		return true;
	}
	const term = process.env.TERM ?? "";
	if (term.includes("kitty") || term.includes("ghostty")) return true;
	return (process.env.TERM_PROGRAM ?? "").toLowerCase() === "ghostty";
}

// tmux >= 3.3 drops DCS passthrough unless `allow-passthrough` is on.
// Checked once; without it the image transfer would be silently discarded.
let allowsPassthrough: boolean | undefined;
function tmuxAllowsPassthrough(): boolean {
	if (allowsPassthrough === undefined) {
		try {
			// -v prints just the value; without it, inherited options render as
			// "allow-passthrough* on" (note the asterisk).
			const output = execFileSync("tmux", ["show", "-Apv", "allow-passthrough"], {
				encoding: "utf8",
				timeout: 1000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			const value = output.trim();
			allowsPassthrough = value === "on" || value === "all";
		} catch {
			allowsPassthrough = false;
		}
	}
	return allowsPassthrough;
}

function useTmuxKittyPath(): boolean {
	return isInsideTmux() && supportsUnicodePlaceholders() && tmuxAllowsPassthrough();
}

class TmuxKittyImage implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private retryGeneration = 0;
	private retryTimers: Array<ReturnType<typeof setTimeout>> = [];

	constructor(
		private readonly base64: string,
		private readonly dimensions: ImageDimensions,
		private readonly imageId: number,
	) {}

	private cancelTransferRetries(): void {
		this.retryGeneration++;
		for (const timer of this.retryTimers) clearTimeout(timer);
		this.retryTimers = [];
	}

	private scheduleTransferRetries(transfer: string): void {
		this.cancelTransferRetries();
		const generation = this.retryGeneration;
		for (const delay of KITTY_RETRY_DELAYS_MS) {
			const timer = setTimeout(() => {
				if (generation !== this.retryGeneration) return;
				process.stdout.write(transfer);
			}, delay);
			timer.unref();
			this.retryTimers.push(timer);
		}
	}

	/** Drop cached lines and cancel pending re-sends (required by Component). */
	invalidate(): void {
		this.cancelTransferRetries();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const maxWidth = Math.max(1, Math.min(width - 2, MAX_WIDTH_CELLS));
		const { columns, rows } = calculateImageCellSize(
			this.dimensions,
			maxWidth,
			MAX_HEIGHT_CELLS,
			getCellDimensions(),
		);
		const transfer = encodeVirtualPlacement(this.base64, this.imageId, columns, rows);
		process.stdout.write(transfer);
		this.scheduleTransferRetries(transfer);

		// Placeholder cells: image id in the foreground color, row/column in
		// combining diacritics. The terminal replaces them with image tiles.
		const red = (this.imageId >>> 16) & 255;
		const green = (this.imageId >>> 8) & 255;
		const blue = this.imageId & 255;
		const foreground = `\x1b[38:2:${red}:${green}:${blue}m`;

		const lines: string[] = [];
		for (let row = 0; row < rows; row++) {
			let line = foreground;
			for (let column = 0; column < columns; column++) {
				line += IMAGE_PLACEHOLDER + NUMBER_TO_DIACRITIC[row] + NUMBER_TO_DIACRITIC[column];
			}
			line += "\x1b[39m";
			lines.push(line);
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

const imageCache = new Map<string, Component>();

/**
 * Build (or reuse) the transcript component for one image file. PNG inside
 * tmux takes the manual kitty path; everything else goes through pi-tui's
 * Image, which renders a text fallback where graphics are unavailable.
 */
export function imageComponentFor(
	path: string,
	mtimeMs: number,
	theme: Theme,
): Component {
	const key = `${path}:${mtimeMs}`;
	const cached = imageCache.get(key);
	if (cached) return cached;

	const base64 = readFileSync(path).toString("base64");
	const mimeType = mimeFor(path);
	const dimensions = getImageDimensions(base64, mimeType);

	let image: Component;
	if (useTmuxKittyPath() && mimeType === "image/png" && dimensions) {
		image = new TmuxKittyImage(base64, dimensions, makeImageId(key));
	} else {
		image = new Image(
			base64,
			mimeType,
			{ fallbackColor: (str) => theme.fg("dim", str) },
			{
				maxWidthCells: MAX_WIDTH_CELLS,
				maxHeightCells: MAX_HEIGHT_CELLS,
				filename: path,
			},
		);
	}

	if (imageCache.size >= IMAGE_CACHE_MAX) {
		const oldest = imageCache.keys().next().value;
		if (oldest !== undefined) imageCache.delete(oldest);
	}
	imageCache.set(key, image);
	return image;
}

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
};

function mimeFor(path: string): string {
	const dot = path.lastIndexOf(".");
	const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
	return MIME_BY_EXT[ext] ?? "image/png";
}

/** Caption + image container used by the entry renderer. */
export function imageEntryComponent(
	path: string,
	mtimeMs: number,
	theme: Theme,
): Container {
	const container = new Container();
	container.addChild(new Text(theme.fg("dim", `\u{1f5bc}  ${path}`), 0, 0));
	try {
		container.addChild(imageComponentFor(path, mtimeMs, theme));
	} catch {
		container.addChild(
			new Text(theme.fg("dim", "(image file no longer available)"), 0, 0),
		);
	}
	return container;
}
