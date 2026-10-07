import { describe, expect, it } from "vitest";
import {
	extractImagePaths,
	isFreshCapture,
	isImagePath,
	isScreenshotCommand,
	mimeForPath,
	MTIME_SLACK_MS,
	shellCommandFromInput,
} from "../lib/cli-capture";

describe("isScreenshotCommand", () => {
	it("matches agent-browser screenshot commands", () => {
		expect(isScreenshotCommand("agent-browser screenshot /tmp/shot.png")).toBe(true);
		expect(isScreenshotCodeStyle()).toBe(true);
	});

	it("ignores unrelated commands", () => {
		expect(isScreenshotCommand("agent-browser click #submit")).toBe(false);
		expect(isScreenshotCommand("echo screenshot")).toBe(false);
		expect(isScreenshotCommand("ls")).toBe(false);
	});

	// Real shape from the exec tool: `agent-browser batch` JSON may carry a
	// screenshot step with the words split across the string.
	function isScreenshotCodeStyle(): boolean {
		return isScreenshotCommand('agent-browser batch --bail <<< \'[["screenshot","/tmp/x.png"]]\'');
	}
});

describe("extractImagePaths", () => {
	it("extracts absolute paths from tool output", () => {
		expect(extractImagePaths("Saved screenshot to /tmp/shots/one.png", "/work")).toEqual([
			"/tmp/shots/one.png",
		]);
	});

	it("resolves ~ against HOME and relative paths against cwd", () => {
		const paths = extractImagePaths("~/pic.jpg shot-2.webp", "/work/dir");
		expect(paths).toContain(`${process.env.HOME}/pic.jpg`);
		expect(paths).toContain("/work/dir/shot-2.webp");
	});

	it("dedupes the same file named in command and output", () => {
		const paths = extractImagePaths("agent-browser screenshot out.png -> out.png", "/w");
		expect(paths).toEqual(["/w/out.png"]);
	});

	it("ignores text without image extensions", () => {
		expect(extractImagePaths("no images here, just file.txt and notes.md", "/w")).toEqual([]);
	});

	it("matches paths after markdown parens and angle brackets", () => {
		expect(extractImagePaths("![shot](/tmp/shots/two.png)", "/w")).toEqual(["/tmp/shots/two.png"]);
		expect(extractImagePaths("Saved: <three.webp>", "/w")).toEqual(["/w/three.webp"]);
	});

	it("matches only the token after the last boundary char", () => {
		// Boundary class is [\s"'=([<:]: a quoted path with spaces yields its
		// final token (ported regex semantics, kept intentionally).
		expect(extractImagePaths('"shot final.png" saved', "/w")).toEqual(["/w/final.png"]);
	});
});

describe("isFreshCapture", () => {
	it("accepts files modified at or after the command start minus slack", () => {
		const startedAt = 1_000_000;
		expect(isFreshCapture(startedAt, startedAt)).toBe(true);
		expect(isFreshCapture(startedAt - MTIME_SLACK_MS, startedAt)).toBe(true);
	});

	it("rejects files older than the slack window", () => {
		const startedAt = 1_000_000;
		expect(isFreshCapture(startedAt - MTIME_SLACK_MS - 1, startedAt)).toBe(false);
	});
});

describe("shellCommandFromInput", () => {
	it("reads the command key across shell tool shapes", () => {
		expect(shellCommandFromInput({ command: "agent-browser screenshot x.png" })).toBe("agent-browser screenshot x.png");
		expect(shellCommandFromInput({ cmd: "ls" })).toBe("ls");
		expect(shellCommandFromInput({ script: "pwd" })).toBe("pwd");
	});

	it("returns empty for junk input", () => {
		expect(shellCommandFromInput(undefined)).toBe("");
		expect(shellCommandFromInput({ command: 42 })).toBe("");
		expect(shellCommandFromInput({ other: true })).toBe("");
	});
});

describe("isImagePath and mimeForPath", () => {
	it("accepts supported extensions case-insensitively", () => {
		expect(isImagePath("/a/b.PNG")).toBe(true);
		expect(isImagePath("/a/b.jpeg")).toBe(true);
		expect(isImagePath("/a/b.txt")).toBe(false);
	});

	it("maps extensions to mimes with png fallback", () => {
		expect(mimeForPath("/a/b.png")).toBe("image/png");
		expect(mimeForPath("/a/b.JPG")).toBe("image/jpeg");
		expect(mimeForPath("/a/noext")).toBe("image/png");
	});
});
