/**
 * pi-image-inline — render images inline in the pi TUI without spending
 * model tokens.
 *
 * Three flows, one entry type ("image-inline"):
 *
 *   1. CAPTURE REDACTION — the native agent_browser tool (and any
 *      *_take_screenshot tool) attaches screenshot pixels to its result.
 *      A tool_result handler strips every image block pre-send and replaces
 *      it with a text placeholder pointing at the saved file. The model
 *      sees text; the user sees the picture, rendered transcript-inline via
 *      appendEntry + a kitty-graphics entry renderer. structuredContent is
 *      always passed back through: rewriting content without it makes pi
 *      drop the tool's structured data.
 *
 *   2. READ EXEMPTION — results of the read tool always pass through
 *      untouched. The model asked for vision explicitly; stripping it would
 *      cause re-read loops. Exception: stripRead lockdown (config or
 *      --image-inline-strip-read), where reads are stripped too and the
 *      placeholder tells the model why.
 *
 *   3. CLI CAPTURES — `agent-browser screenshot <path>` via the shell never
 *      carries pixels; the result text names the file. TUI-only render, no
 *      rewrite. Detection: command words + mtime gate, so only files the
 *      command actually produced are inlined.
 *
 * Nested tool calls (parentToolCallId present) are still redacted but never
 * produce transcript entries: nested results must not draw in the transcript.
 *
 * Uninstall pi-image-preview and jnsahaj/pi-agent-browser-screenshot when
 * installing this package: preview re-injects stripped pixels.
 */
import type {
	ExtensionAPI,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractImagePaths,
	isFreshCapture,
	isScreenshotCommand,
	shellCommandFromInput,
	MAX_FILE_BYTES,
} from "../lib/cli-capture";
import { imageEntryComponent } from "../lib/kitty";
import {
	capturePlaceholder,
	extForMime,
	findStructuredImages,
	isCaptureTool,
	readPlaceholder,
	redactImages,
	type ContentBlock,
	type ImageBlock,
	type ImageInfo,
} from "../lib/redact";
import { loadStripRead } from "../lib/settings";

const ENTRY_TYPE = "image-inline";
const STRIP_READ_FLAG = "image-inline-strip-read";

interface EntryData {
	path: string;
	mtimeMs: number;
}

export default function (pi: ExtensionAPI) {
	// Flags are in-memory only, so the persisted choice seeds the default and
	// the CLI flag (--image-inline-strip-read) overrides per session.
	pi.registerFlag(STRIP_READ_FLAG, {
		description:
			"Strip image pixels from read results too (zero-pixel lockdown runs). Default false.",
		type: "boolean",
		default: loadStripRead(),
	});

	function stripReadActive(): boolean {
		const flag = pi.getFlag(STRIP_READ_FLAG);
		return typeof flag === "boolean" ? flag : loadStripRead();
	}

	const cliStartTimes = new Map<string, number>();

	// The shell tool's name varies per toolset (bash, exec_command, ...), so
	// capture detection keys off the command string alone.
	pi.on("tool_execution_start", (event) => {
		if (isScreenshotCommand(shellCommandFromInput(event.args))) {
			cliStartTimes.set(event.toolCallId, Date.now());
		}
	});

	pi.on("tool_result", (event, ctx): ToolResultEventResult | undefined => {
		if (event.isError) {
			// Failed commands produce no captures; drop their start-time entry
			// so the map cannot leak across a long session.
			cliStartTimes.delete(event.toolCallId);
			return;
		}

		if (event.toolName === "read") {
			// Exempt by default: the model asked for vision explicitly.
			if (!stripReadActive()) return;
			return stripImages(event, readPlaceholder);
		}

		if (isCaptureTool(event.toolName)) {
			return stripImages(event, capturePlaceholder);
		}

		if (cliStartTimes.has(event.toolCallId)) {
			renderCliCaptures(event, pi, ctx.cwd);
		}
		return undefined;
	});

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const { path, mtimeMs } = entry.data as EntryData;
		return imageEntryComponent(path, mtimeMs, theme);
	});

	/**
	 * Replace image blocks with placeholders, pass structuredContent back
	 * through, and queue transcript entries so the user still sees the
	 * picture. Returns undefined (no rewrite) when there is nothing to strip.
	 */
	function stripImages(
		event: ToolResultEvent,
		placeholderFor: (info: ImageInfo) => string,
	): ToolResultEventResult | undefined {
		const content = event.content as ContentBlock[];
		if (!content.some((block) => block.type === "image")) return undefined;

		// structuredContent first (typed contract); details only when it
		// carries nothing, so the two views of one capture never concatenate
		// into duplicate facts that would misalign multi-image indexes.
		const fromStructured = findStructuredImages(event.structuredContent);
		const structured =
			fromStructured.length > 0
				? fromStructured
				: findStructuredImages(event.details);

		const entries: EntryData[] = [];
		const result = redactImages(content, (i, block) => {
			const info = resolveInfo(structured[i], block);
			if (info.path) entries.push({ path: info.path, mtimeMs: mtimeOf(info.path) });
			return placeholderFor(info);
		});

		// Nested calls must not produce transcript entries; they are still
		// redacted above so pixels never reach the calling model either.
		if (!event.parentToolCallId) {
			for (const entry of entries) {
				pi.appendEntry(ENTRY_TYPE, entry);
			}
		}

		return { content: result.content, structuredContent: event.structuredContent };
	}

	/**
	 * Fill one image's facts: structured data first, then measure the inline
	 * base64, then fall back to a temp cache file so the renderer always has
	 * a path on disk.
	 */
	function resolveInfo(structured: ImageInfo | undefined, block: ImageBlock): ImageInfo {
		const info: ImageInfo = {
			path: structured?.path,
			width: structured?.width,
			height: structured?.height,
		};
		if (!info.path) {
			const cached = cacheImageFile(block);
			if (cached) info.path = cached;
		}
		if (info.width === undefined || info.height === undefined) {
			const dims = getImageDimensions(block.data, block.mimeType);
			if (dims) {
				info.width = dims.widthPx;
				info.height = dims.heightPx;
			}
		}
		return info;
	}

	/** TUI-only path: find files a shell screenshot command produced. */
	function renderCliCaptures(event: ToolResultEvent, pi: ExtensionAPI, cwd: string): void {
		const startedAt = cliStartTimes.get(event.toolCallId);
		if (startedAt === undefined) return;
		cliStartTimes.delete(event.toolCallId);
		if (event.parentToolCallId) return;

		const command = shellCommandFromInput(event.input);
		const output = (event.content as ContentBlock[])
			.filter((block) => block.type === "text")
			.map((block) => (block as { text: string }).text)
			.join("\n");

		const seen = new Set<string>();
		for (const candidate of [
			...extractImagePaths(output, cwd),
			...extractImagePaths(command, cwd),
		]) {
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			let mtimeMs: number;
			try {
				const stat = statSync(candidate);
				if (stat.size > MAX_FILE_BYTES) continue;
				mtimeMs = stat.mtimeMs;
			} catch {
				continue;
			}
			// Only inline files this command actually produced, not older
			// images that merely appear in its output.
			if (!isFreshCapture(mtimeMs, startedAt)) continue;
			pi.appendEntry(ENTRY_TYPE, { path: candidate, mtimeMs });
		}
	}
}

function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Last-resort path for image blocks that name no file: write the pixels to a
 * temp cache so the transcript renderer has something to read after resume.
 * The dir is per-user and 0700, and the write is exclusive, so another local
 * user can neither plant a symlink nor pre-place a file we would follow.
 */
function cacheImageFile(block: ImageBlock): string {
	const hash = createHash("sha1").update(block.data).digest("hex");
	const ext = extForMime(block.mimeType) ?? "bin";
	const dir = join(tmpdir(), `pi-image-inline-${process.getuid?.() ?? "user"}`);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, `${hash}.${ext}`);
		// "wx" fails on any existing entry (including attacker symlinks); an
		// EEXIST for our own hash means the bytes are already cached.
		try {
			writeFileSync(path, Buffer.from(block.data, "base64"), { flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		return path;
	} catch {
		return "";
	}
}
