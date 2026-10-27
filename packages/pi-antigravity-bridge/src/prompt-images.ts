// Stream-json prompt staging: user-attached image blocks cannot ride the CLI's
// text-only turn input, so they are staged to temp files and the prompt points
// the model at them. The model views them through the bridge read tool, whose
// tool-result image content the CLI's MCP client delivers (probe 2026-09-07).
// The ACP engine does not use this module: image blocks ride session/prompt
// natively.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STAGE_DIR_PREFIX = "pi-bridge-img-";

/** Retention for staged files: the model may re-read them on later turns of
 *  the same conversation, so sweeps cannot delete a dir this turn's prompt
 *  still references. */
export const STAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface StagedImage {
	data: string;
	mimeType: string;
}

const EXT_BY_MIME: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/bmp": ".bmp",
};

function sweepStale(root: string): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return;
	}
	const cutoff = Date.now() - STAGE_MAX_AGE_MS;
	for (const entry of entries) {
		if (!entry.startsWith(STAGE_DIR_PREFIX)) continue;
		const full = path.join(root, entry);
		try {
			if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
		} catch {
			// Raced with another process's sweep or deletion: nothing to do.
		}
	}
}

/** Write image blocks to a fresh staging dir under `root` (default the OS tmp
 *  dir). Returns null on any failure: the turn then runs text-only instead of
 *  failing. */
export function stagePromptImages(
	images: Array<StagedImage>,
	root?: string,
): { dir: string; paths: string[] } | null {
	try {
		sweepStale(root ?? os.tmpdir());
		const dir = fs.mkdtempSync(path.join(root ?? os.tmpdir(), STAGE_DIR_PREFIX));
		const paths = images.map((img, i) => {
			const ext = EXT_BY_MIME[img.mimeType] ?? ".bin";
			const file = path.join(dir, `image-${i + 1}${ext}`);
			fs.writeFileSync(file, Buffer.from(img.data, "base64"), { mode: 0o600 });
			return file;
		});
		return { dir, paths };
	} catch {
		return null;
	}
}

export function buildImageNote(paths: string[]): string {
	const list = paths.map((p) => `- ${p}`).join("\n");
	return `[The user attached ${paths.length} image(s) to this message. They are staged at:\n${list}\nView them by calling the pi read tool on these exact paths; the image content is delivered to you directly.]`;
}
