import { describe, expect, it } from "vitest";
import {
	capturePlaceholder,
	extForMime,
	findStructuredImages,
	isCaptureTool,
	readPlaceholder,
	redactImages,
	type ContentBlock,
	type ImageInfo,
} from "../lib/redact";

const IMG_A = "/home/e/shots/a.png";
const IMG_B = "/home/e/shots/b.jpg";

function text(t: string): ContentBlock {
	return { type: "text", text: t };
}

function image(data = "QUJD", mimeType = "image/png"): ContentBlock {
	return { type: "image", data, mimeType };
}

describe("isCaptureTool", () => {
	it("matches the native browser tool", () => {
		expect(isCaptureTool("agent_browser")).toBe(true);
	});

	it("matches explicit and suffixed screenshot tools", () => {
		expect(isCaptureTool("chrome_devtools_take_screenshot")).toBe(true);
		expect(isCaptureTool("mcp__playwright__browser_take_screenshot")).toBe(true);
	});

	it("does not match unrelated tools", () => {
		expect(isCaptureTool("read")).toBe(false);
		expect(isCaptureTool("bash")).toBe(false);
		expect(isCaptureTool("agent_browser_code")).toBe(false);
		expect(isCaptureTool("take_screenshot")).toBe(false);
		expect(isCaptureTool("screenshot_tool")).toBe(false);
	});
});

describe("redactImages", () => {
	it("replaces each image block with one placeholder and keeps text blocks", () => {
		const content = [text("before"), image(), text("middle"), image("WFla", "image/jpeg")];
		const result = redactImages(content, (i) => `ph-${i}`);
		expect(result.content).toEqual([text("before"), { type: "text", text: "ph-0" }, text("middle"), { type: "text", text: "ph-1" }]);
		expect(result.redacted).toHaveLength(2);
	});

	it("returns content unchanged when there are no images", () => {
		const content = [text("plain")];
		const result = redactImages(content, () => "never");
		expect(result.content).toEqual(content);
		expect(result.redacted).toHaveLength(0);
	});

	it("handles image-only content", () => {
		const result = redactImages([image(), image()], (i) => `p${i}`);
		expect(result.content).toEqual([{ type: "text", text: "p0" }, { type: "text", text: "p1" }]);
	});
});

describe("capturePlaceholder", () => {
	it("carries path and dimensions in the locked wording", () => {
		const info: ImageInfo = { path: IMG_A, width: 1280, height: 800 };
		expect(capturePlaceholder(info)).toBe(
			`[Screenshot captured and rendered in terminal for user: ${IMG_A} (1280x800). Model vision was not loaded to save tokens. To inspect pixels agentically, call the read tool on this path.]`,
		);
	});

	it("degrades to unknown without facts", () => {
		expect(capturePlaceholder({})).toBe(
			"[Screenshot captured and rendered in terminal for user: unknown path (unknown). Model vision was not loaded to save tokens. To inspect pixels agentically, call the read tool on this path.]",
		);
	});
});

describe("readPlaceholder", () => {
	it("must not instruct the model to call read (loop guard under stripRead)", () => {
		const text = readPlaceholder({ path: IMG_A, width: 10, height: 10 });
		expect(text).not.toContain("call the read tool");
		expect(text).toContain(IMG_A);
		expect(text).toContain("10x10");
	});
});

describe("findStructuredImages", () => {
	it("reads imageObservations with pixel size from a presentation", () => {
		const presentation = {
			imagePath: IMG_A,
			imageObservations: [{ path: IMG_A, mimeType: "image/png", pixels: { width: 1280, height: 800 } }],
		};
		expect(findStructuredImages(presentation)).toEqual([{ path: IMG_A, width: 1280, height: 800 }]);
	});

	it("falls back to imagePath when observations are absent", () => {
		expect(findStructuredImages({ imagePath: IMG_B })).toEqual([{ path: IMG_B }]);
	});

	it("finds the presentation nested inside a wrapper object", () => {
		const wrapper = { result: { data: { imageObservations: [{ path: IMG_A, pixels: { width: 5, height: 6 } }] } } };
		expect(findStructuredImages(wrapper)).toEqual([{ path: IMG_A, width: 5, height: 6 }]);
	});

	it("aggregates observations across a batch array (multi-image alignment)", () => {
		const batch = [
			{ imageObservations: [{ path: IMG_A, pixels: { width: 1, height: 2 } }] },
			{ imageObservations: [{ path: IMG_B, pixels: { width: 3, height: 4 } }] },
		];
		expect(findStructuredImages(batch)).toEqual([
			{ path: IMG_A, width: 1, height: 2 },
			{ path: IMG_B, width: 3, height: 4 },
		]);
	});

	it("collects sibling imagePath keys and dedupes repeats", () => {
		const mixed = { first: { imagePath: IMG_A }, second: { imagePath: IMG_A } };
		expect(findStructuredImages(mixed)).toEqual([{ path: IMG_A }]);
	});

	it("ignores malformed observations and returns nothing without image data", () => {
		expect(findStructuredImages({ imageObservations: ["junk", null, 42] })).toEqual([]);
		expect(findStructuredImages({ hello: "world" })).toEqual([]);
		expect(findStructuredImages(undefined)).toEqual([]);
		expect(findStructuredImages({ imageObservations: [] })).toEqual([]);
	});

	it("respects the search depth guard", () => {
		let deep: Record<string, unknown> = { imageObservations: [{ path: IMG_A }] };
		for (let i = 0; i < 10; i++) deep = { nested: deep };
		expect(findStructuredImages(deep)).toEqual([]);
	});
});

describe("extForMime", () => {
	it("maps known image mimes and rejects others", () => {
		expect(extForMime("image/png")).toBe("png");
		expect(extForMime("IMAGE/JPEG")).toBe("jpg");
		expect(extForMime("application/json")).toBeUndefined();
	});
});
