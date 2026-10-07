import { describe, expect, it } from "vitest";
import {
	calculateImageCellSize,
	encodeVirtualPlacement,
	makeImageId,
	wrapTmuxPassthrough,
} from "../lib/kitty";

const CELLS = { widthPx: 10, heightPx: 20 };

describe("makeImageId", () => {
	it("is stable for a key and nonzero", () => {
		expect(makeImageId("/a.png:1")).toBe(makeImageId("/a.png:1"));
		expect(makeImageId("/a.png:1")).toBeGreaterThan(0);
	});

	it("fits in 24 bits (placeholder foreground-color contract)", () => {
		const id = makeImageId("/b.png:2");
		expect(id).toBeLessThanOrEqual(0xffffff);
	});
});

describe("wrapTmuxPassthrough", () => {
	it("wraps in DCS tmux and doubles inner ESC bytes", () => {
		const wrapped = wrapTmuxPassthrough("\x1b_Gf=100;\x1b\\");
		expect(wrapped).toBe("\x1bPtmux;\x1b\x1b_Gf=100;\x1b\x1b\\\x1b\\");
	});
});

describe("encodeVirtualPlacement", () => {
	it("sends one quiet chunk with header controls for small images", () => {
		const out = encodeVirtualPlacement("QUJD", 7, 40, 12);
		expect(out).toBe(wrapTmuxPassthrough("\x1b_Ga=T,f=100,U=1,i=7,c=40,r=12,q=2,m=0;QUJD\x1b\\"));
		expect(out.startsWith("\x1bPtmux;")).toBe(true);
		expect(out.endsWith("\x1b\\")).toBe(true);
		// Every ESC in the payload must be doubled for tmux: after collapsing
		// doubled ESCs, no raw kitty sequence may remain.
		expect(out.replaceAll("\x1b\x1b", "").includes("\x1b_G")).toBe(false);
	});

	it("chunks per the 4096-byte protocol limit with m=1/m=0 flags", () => {
		const base64 = "A".repeat(5000);
		const out = encodeVirtualPlacement(base64, 9, 10, 10);
		const chunks = out.split("\x1bPtmux;").filter(Boolean);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toContain("a=T,f=100,U=1,i=9,c=10,r=10,q=2,m=1;");
		expect(chunks[0]).toContain("A".repeat(4096));
		expect(chunks[1]).toMatch(/m=0;A{904}/);
	});
});

describe("calculateImageCellSize", () => {
	it("clamps wide images to max width cells", () => {
		const size = calculateImageCellSize(
			{ widthPx: 2000, heightPx: 500 },
			100,
			30,
			CELLS,
		);
		expect(size.columns).toBe(100);
		expect(size.rows).toBeLessThanOrEqual(30);
	});

	it("clamps tall images to max height cells", () => {
		const size = calculateImageCellSize(
			{ widthPx: 500, heightPx: 4000 },
			100,
			30,
			CELLS,
		);
		expect(size.rows).toBe(30);
		expect(size.columns).toBeLessThanOrEqual(100);
	});

	it("fills the max box, scaling up small images (ported semantics)", () => {
		const size = calculateImageCellSize({ widthPx: 100, heightPx: 100 }, 100, 30, CELLS);
		// scale = min(100*10/100, 30*20/100) = 6 -> 600px box -> 60x30 cells.
		expect(size).toEqual({ columns: 60, rows: 30 });
	});
});
