import { describe, it, expect } from "vitest";
import { analyzeDiff, isHunkSource, pathLanguage } from "../extensions/diff.js";

const DIFF = [
	"diff --git a/foo.go b/foo.go",
	"index 1111111..2222222 100644",
	"--- a/foo.go",
	"+++ b/foo.go",
	"@@ -1,3 +1,4 @@",
	" package main",
	" ",
	'+import "fmt"',
	"diff --git a/bar.py b/bar.py",
	"--- a/bar.py",
	"+++ b/bar.py",
	"@@ -1,2 +1,2 @@",
	"-from os import path",
	"+from os import path as p",
	"\\ No newline at end of file",
].join("\n");

describe("pathLanguage", () => {
	it("detects by extension, case-insensitive", () => {
		expect(pathLanguage("a/b.go")).toBe("go");
		expect(pathLanguage("x.PY")).toBe("python");
		expect(pathLanguage("a.ts")).toBe("javascript");
		expect(pathLanguage("a.tsx")).toBe("javascript");
		expect(pathLanguage("a.rs")).toBe("rust");
		expect(pathLanguage("a.hpp")).toBe("c");
		expect(pathLanguage("a.java")).toBe("java");
		expect(pathLanguage("Makefile")).toBe("unknown");
	});
});

describe("analyzeDiff", () => {
	const a = analyzeDiff(DIFF);

	it("splits into physical lines without a phantom trailing line", () => {
		expect(a.lines.length).toBe(15);
		expect(a.lines[0]).toBe("diff --git a/foo.go b/foo.go");
	});

	it("classifies structural lines", () => {
		expect(a.kinds[0]).toBe("header");
		expect(a.kinds[1]).toBe("index");
		expect(a.kinds[2]).toBe("oldFile");
		expect(a.kinds[3]).toBe("newFile");
		expect(a.kinds[4]).toBe("hunkHeader");
		expect(a.kinds[7]).toBe("hunkChange"); // +import "fmt"
		expect(a.kinds[14]).toBe("noNewline");
	});

	it("classifies context vs change in a hunk", () => {
		expect(a.kinds[5]).toBe("hunkContext"); //  package main
		expect(a.kinds[6]).toBe("hunkContext"); //  (blank context)
		expect(a.kinds[12]).toBe("hunkChange"); // -from os ...
		expect(a.kinds[13]).toBe("hunkChange"); // +from os ...
	});

	it("ends a hunk at the next file header and restarts ids", () => {
		expect(a.kinds[8]).toBe("header"); // second diff --git
		expect(a.fileIds[0]).toBe(0);
		expect(a.fileIds[8]).toBe(1);
		expect(a.hunkIds[4]).toBe(0);
		expect(a.hunkIds[11]).toBe(0); // new file resets hunk id
	});

	it("tags each file's source language", () => {
		expect(a.languages[7]).toBe("go");
		expect(a.languages[12]).toBe("python");
		expect(a.languages[13]).toBe("python");
	});

	it("attaches a no-newline marker to its preceding source line", () => {
		expect(a.markerOwner[14]).toBe(13);
		expect(a.markerOwner[0]).toBe(-1);
	});

	it("treats a paired --- / +++ as file markers, not removals", () => {
		// The --- a/bar.py at index 9 is a file marker, not a hunkChange.
		expect(a.kinds[9]).toBe("oldFile");
		expect(a.kinds[10]).toBe("newFile");
	});
});

describe("isHunkSource", () => {
	it("context and change are source; headers are not", () => {
		expect(isHunkSource("hunkContext")).toBe(true);
		expect(isHunkSource("hunkChange")).toBe(true);
		expect(isHunkSource("hunkHeader")).toBe(false);
		expect(isHunkSource("header")).toBe(false);
	});
});
