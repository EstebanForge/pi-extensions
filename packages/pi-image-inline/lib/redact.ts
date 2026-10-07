// Pure redaction logic for pi-image-inline.
//
// Decides which tool results carry capture pixels, and rewrites their content
// so image blocks never reach the model. Keeps no state; the extension wiring
// in extensions/ owns I/O (stat, cache files, appendEntry) and injects the
// dimension measurer so this module stays unit-testable without pi-tui.

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export type ContentBlock = TextBlock | ImageBlock;

/** Image facts resolved for one redacted block, in content order. */
export interface ImageInfo {
	path?: string;
	width?: number;
	height?: number;
}

/** Capture tools whose image results exist for the user's eyes only. */
export function isCaptureTool(toolName: string): boolean {
	return toolName === "agent_browser" || toolName.endsWith("_take_screenshot");
}

/** Dimension measurer signature (pi-tui's getImageDimensions matches). */
export type MeasureImage = (
	base64: string,
	mimeType: string,
) => { widthPx: number; heightPx: number } | undefined;

// The capture placeholder wording is locked by the behavior contract; keep it
// one whole literal per branch so greps and reviews see it intact. The read
// branch must NOT tell the model to call read again: under stripRead lockdown
// that read is stripped too, and the instruction would loop.
export function capturePlaceholder(info: ImageInfo): string {
	return `[Screenshot captured and rendered in terminal for user: ${info.path ?? "unknown path"} (${dims(info)}). Model vision was not loaded to save tokens. To inspect pixels agentically, call the read tool on this path.]`;
}

export function readPlaceholder(info: ImageInfo): string {
	return `[Image read rendered in terminal for user: ${info.path ?? "unknown path"} (${dims(info)}). Model vision was not loaded to save tokens. stripRead lockdown is active; ask the operator to disable it if these pixels are needed.]`;
}

function dims(info: ImageInfo): string {
	if (info.width === undefined || info.height === undefined) return "unknown";
	return `${info.width}x${info.height}`;
}

/**
 * Replace every image block with one text placeholder. Returns the new
 * content plus the redacted blocks in order, so the wiring can resolve
 * per-image facts (path, mtime) and queue transcript entries.
 */
export function redactImages(
	content: ContentBlock[],
	placeholderFor: (index: number, block: ImageBlock) => string,
): { content: ContentBlock[]; redacted: ImageBlock[] } {
	const out: ContentBlock[] = [];
	const redacted: ImageBlock[] = [];
	let imageIndex = 0;
	for (const block of content) {
		if (block.type === "image") {
			out.push({ type: "text", text: placeholderFor(imageIndex, block) });
			redacted.push(block);
			imageIndex++;
		} else {
			out.push(block);
		}
	}
	return { content: out, redacted };
}

/**
 * Pull image facts (path, pixel size) from a tool result's structured side.
 * The native agent_browser tool stores them on its presentation object as
 * `imageObservations[{path, pixels{width,height}}]` with a top-level
 * `imagePath`; that object may arrive via structuredContent or details.
 * Order matches content order for the single-capture case; extra entries
 * are ignored, missing entries fall back to measurement by the caller.
 */
export function findStructuredImages(value: unknown): ImageInfo[] {
	const found = search(value, 0);
	return dedupeByPath(found);
}

const MAX_SEARCH_DEPTH = 4;

function search(value: unknown, depth: number): ImageInfo[] {
	if (value === null || typeof value !== "object" || depth > MAX_SEARCH_DEPTH) {
		return [];
	}
	if (Array.isArray(value)) {
		// First array element that yields observations wins; keeps batch
		// envelopes from merging unrelated captures.
		for (const item of value) {
			const hit = search(item, depth + 1);
			if (hit.length > 0) return hit;
		}
		return [];
	}
	const rec = value as Record<string, unknown>;
	const observations = rec.imageObservations;
	if (Array.isArray(observations) && observations.length > 0) {
		const infos: ImageInfo[] = [];
		for (const obs of observations) {
			if (obs === null || typeof obs !== "object") continue;
			const o = obs as Record<string, unknown>;
			const pixels =
				o.pixels !== null && typeof o.pixels === "object"
					? (o.pixels as Record<string, unknown>)
					: undefined;
			infos.push({
				path: typeof o.path === "string" ? o.path : undefined,
				width: numberOf(pixels?.width),
				height: numberOf(pixels?.height),
			});
		}
		if (infos.length > 0) return infos;
	}
	if (typeof rec.imagePath === "string") {
		return [{ path: rec.imagePath }];
	}
	for (const child of Object.values(rec)) {
		const hit = search(child, depth + 1);
		if (hit.length > 0) return hit;
	}
	return [];
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function dedupeByPath(infos: ImageInfo[]): ImageInfo[] {
	const seen = new Set<string>();
	const out: ImageInfo[] = [];
	for (const info of infos) {
		const key = info.path ?? `\u0000index:${out.length}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(info);
	}
	return out;
}

/** File extension for an image MIME type; undefined when not a known image. */
export function extForMime(mimeType: string): string | undefined {
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/webp": "webp",
		"image/gif": "gif",
		"image/bmp": "bmp",
	};
	return map[mimeType.toLowerCase()];
}
