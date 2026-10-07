// CLI-capture detection for pi-image-inline.
//
// When the agent captures a screenshot through the shell (agent-browser
// screenshot <path>), the pixels never enter the model context: the tool
// result is plain text naming the file. The only job here is finding which
// file that command produced so the transcript can render it inline.
// Ported from jnsahaj/pi-agent-browser-screenshot (MIT).

export const IMAGE_PATH_RE =
	/(?:^|[\s"'=])((?:[~./\\]|\/)?[\w~@./\\-]+\.(?:png|jpe?g|webp|gif|bmp))/gi;

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Files modified this long before the command started still count as its
// output, to absorb clock/fs-timestamp slop.
export const MTIME_SLACK_MS = 2000;

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp)$/i;

const MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
};

export function isScreenshotCommand(command: string): boolean {
	return command.includes("agent-browser") && command.includes("screenshot");
}

/**
 * Pull the command string out of a shell tool's input. The shell tool name
 * differs per toolset (bash, exec_command, powershell), and so does the
 * input key (command, cmd); capture detection keys off the string, not the
 * tool name.
 */
export function shellCommandFromInput(input: unknown): string {
	if (input === null || typeof input !== "object") return "";
	const rec = input as Record<string, unknown>;
	for (const key of ["command", "cmd", "script"]) {
		if (typeof rec[key] === "string") return rec[key] as string;
	}
	return "";
}

/** Absolute paths of image files named in text; ~ and relative resolve against cwd. */
export function extractImagePaths(text: string, cwd: string): string[] {
	const paths = new Set<string>();
	for (const match of text.matchAll(IMAGE_PATH_RE)) {
		let candidate = match[1];
		if (candidate.startsWith("~/")) {
			candidate = resolveHome(candidate.slice(2));
		}
		if (!candidate.startsWith("/")) {
			candidate = `${cwd.replace(/\/$/, "")}/${candidate}`;
		}
		paths.add(candidate);
	}
	return [...paths];
}

/**
 * Only files the command actually produced, not older images that merely
 * appear in its output. Boundary-inclusive at the slack edge.
 */
export function isFreshCapture(mtimeMs: number, startedAtMs: number): boolean {
	return mtimeMs >= startedAtMs - MTIME_SLACK_MS;
}

export function isImagePath(path: string): boolean {
	return IMAGE_EXTENSIONS.test(path);
}

export function mimeForPath(path: string): string {
	return MIME_TYPES[extname(path).toLowerCase()] ?? "image/png";
}

function extname(path: string): string {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	return dot === -1 ? "" : base.slice(dot);
}

function resolveHome(relative: string): string {
	const home = process.env.HOME ?? "";
	if (!home) return `~/${relative}`;
	return `${home.replace(/\/$/, "")}/${relative}`;
}
