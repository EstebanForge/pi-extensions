import { describe, it, expect } from "vitest";
import { sizeOk, splitForChunking, mergeResults } from "../extensions/index.js";
import type { CompileResult } from "../extensions/compiler.js";

function fileSection(name: string, body: string): string {
	return [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, "@@ -1,1 +1,1 @@", body].join(
		"\n",
	);
}

function fakeResult(over: Partial<CompileResult>): CompileResult {
	return {
		abridged: "",
		summary: "",
		visibleChanged: 0,
		removedChanged: 0,
		foldedChanged: 0,
		totalChanged: 0,
		totalLines: 0,
		folds: 0,
		markers: 0,
		files: { kept: 0, total: 0 },
		allElided: false,
		...over,
	};
}

describe("sizeOk", () => {
	it("accepts a small diff and rejects a large one", () => {
		expect(sizeOk("diff --git")).toBe(true);
		expect(sizeOk("x".repeat(80_001))).toBe(false);
		expect(sizeOk("\n".repeat(2001))).toBe(false);
	});
});

describe("splitForChunking", () => {
	it("splits a multi-file diff at file boundaries", () => {
		const diff = [fileSection("a.go", "+a := 1"), fileSection("b.go", "+b := 2"), fileSection("c.go", "+c := 3")].join(
			"\n",
		);
		const chunks = splitForChunking(diff);
		expect(chunks.length).toBe(3);
		for (const c of chunks) expect(c.startsWith("diff --git")).toBe(true);
		expect(chunks[0]).toContain("a.go");
		expect(chunks[1]).toContain("b.go");
		expect(chunks[2]).toContain("c.go");
	});

	it("returns one chunk for a single small file", () => {
		const chunks = splitForChunking(fileSection("a.go", "+a := 1"));
		expect(chunks.length).toBe(1);
	});
});

describe("mergeResults", () => {
	it("sums stats, joins the abridged diff, and dedupes the summary", () => {
		const merged = mergeResults([
			fakeResult({ abridged: "diff --git a/a\n+foo", summary: "add foo", visibleChanged: 1, totalChanged: 2, files: { kept: 1, total: 1 } }),
			fakeResult({ abridged: "diff --git a/b\n+bar", summary: "add foo", visibleChanged: 1, totalChanged: 1, files: { kept: 1, total: 1 } }),
		]);
		expect(merged.abridged).toBe("diff --git a/a\n+foo\ndiff --git a/b\n+bar");
		expect(merged.summary).toBe("add foo"); // deduped
		expect(merged.visibleChanged).toBe(2);
		expect(merged.totalChanged).toBe(3);
		expect(merged.files).toEqual({ kept: 2, total: 2 });
		expect(merged.allElided).toBe(false);
	});

	it("reports all-elided when every part is empty", () => {
		const merged = mergeResults([fakeResult({}), fakeResult({})]);
		expect(merged.allElided).toBe(true);
		expect(merged.abridged).toBe("");
	});
});
