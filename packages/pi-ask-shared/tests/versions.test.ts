import { describe, expect, it } from "vitest";
import { compareVersionsDesc } from "../src/versions.js";

// Characterization suite: compareVersionsDesc is copied verbatim from
// pi-ask-codex and pi-ask-antigravity. Locks the descending numeric ordering
// the model-catalog sorting depends on. Callers pass numeric dotted segments
// only ("6.1"), never full slugs.

describe("compareVersionsDesc", () => {
	it("ranks 5.10 above 5.9 (lexical sort would invert)", () => {
		expect(compareVersionsDesc("5.9", "5.10")).toBeGreaterThan(0);
		expect(compareVersionsDesc("5.10", "5.9")).toBeLessThan(0);
	});

	it("ranks 6.10 above 6.1", () => {
		expect(compareVersionsDesc("6.1", "6.10")).toBeGreaterThan(0);
	});

	it("returns 0 for equal versions", () => {
		expect(compareVersionsDesc("6.1", "6.1")).toBe(0);
	});

	it("pads missing segments with 0 (1.0.1 above 1.0)", () => {
		expect(compareVersionsDesc("1.0", "1.0.1")).toBeGreaterThan(0);
		expect(compareVersionsDesc("1.0", "1.0.0")).toBe(0);
	});

	it("compares major segments first", () => {
		expect(compareVersionsDesc("6.0", "5.99")).toBeLessThan(0);
	});
});
