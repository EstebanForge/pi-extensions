import { describe, it, expect } from "vitest";
import { analyzeDiff } from "../extensions/diff.js";
import { mandatoryImportMask } from "../extensions/imports.js";

/** Build a one-file diff string from its body lines (file header auto-added). */
function fileDiff(path: string, hunkHeader: string, ...body: string[]): string {
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		hunkHeader,
		...body,
	].join("\n");
}

function maskOf(diff: string): boolean[] {
	return mandatoryImportMask(analyzeDiff(diff));
}

describe("mandatoryImportMask — single-line imports", () => {
	it("hides a Go single import", () => {
		const m = maskOf(fileDiff("a.go", "@@ -1,1 +1,1 @@", '-import "fmt"', '+import "os"'));
		expect(m[4]).toBe(true); // -import "fmt"
		expect(m[5]).toBe(true); // +import "os"
	});

	it("hides Python import and from-import", () => {
		const m = maskOf(fileDiff("a.py", "@@ -1,2 +1,2 @@", "-import os", "+from os import path"));
		expect(m[4]).toBe(true);
		expect(m[5]).toBe(true);
	});

	it("hides a JS/TS from-import and a side-effect import", () => {
		const m = maskOf(
			fileDiff("a.ts", "@@ -1,2 +1,2 @@", '-import { x } from "y"', '+import "z/side"'),
		);
		expect(m[4]).toBe(true);
		expect(m[5]).toBe(true);
	});

	it("hides a Rust use and a C include and a Java import", () => {
		const rs = maskOf(fileDiff("a.rs", "@@ -1,1 +1,1 @@", "+use std::fmt::Debug;"));
		expect(rs[4]).toBe(true);
		const c = maskOf(fileDiff("a.c", "@@ -1,1 +1,1 @@", "+#include <stdio.h>"));
		expect(c[4]).toBe(true);
		const j = maskOf(fileDiff("a.java", "@@ -1,1 +1,1 @@", "+import com.foo.Bar;"));
		expect(j[4]).toBe(true);
	});
});

describe("mandatoryImportMask — multiline imports", () => {
	it("hides a whole Go import block", () => {
		const m = maskOf(
			fileDiff("a.go", "@@ -1,1 +1,4 @@", "+import (", '+\t"fmt"', '+\t"os"', "+)"),
		);
		expect(m.slice(4, 8)).toEqual([true, true, true, true]);
	});

	it("hides a parenthesized Python from-import", () => {
		const m = maskOf(
			fileDiff(
				"a.py",
				"@@ -1,1 +1,4 @@",
				"+from os import (",
				"+    path,",
				"+    sep,",
				"+)",
			),
		);
		expect(m.slice(4, 8)).toEqual([true, true, true, true]);
	});

	it("hides a braced multiline Rust use", () => {
		const m = maskOf(
			fileDiff("a.rs", "@@ -1,1 +1,4 @@", "+use std::fmt::{", "+    Display,", "+    Debug,", "+};"),
		);
		expect(m.slice(4, 8)).toEqual([true, true, true, true]);
	});
});

describe("mandatoryImportMask — does not touch non-imports", () => {
	it("leaves a function call and package line visible", () => {
		const m = maskOf(
			fileDiff("a.go", "@@ -1,3 +1,4 @@", " package main", '+import "os"', '+\tfmt.Println("hi")'),
		);
		expect(m[4]).toBe(false); //  package main (context, not import)
		expect(m[5]).toBe(true); // +import "os"
		expect(m[6]).toBe(false); // +fmt.Println(...)
	});
});

describe("mandatoryImportMask — framing", () => {
	it("drops an import-only file's metadata too", () => {
		// Only change in the file is an import swap: every source line is hidden,
		// so the hunk header and file metadata are hidden as well.
		const m = maskOf(fileDiff("a.go", "@@ -1,1 +1,1 @@", '-import "fmt"', '+import "os"'));
		expect(m.slice(0, 6)).toEqual([true, true, true, true, true, true]);
	});

	it("keeps metadata when the file has a real (non-import) change", () => {
		const m = maskOf(
			fileDiff("a.go", "@@ -1,3 +1,4 @@", " package main", '+import "os"', '+\tfmt.Println("hi")'),
		);
		// Header / --- / +++ / @@ are NOT hidden because a real change survives.
		expect(m[0]).toBe(false);
		expect(m[1]).toBe(false);
		expect(m[2]).toBe(false);
		expect(m[3]).toBe(false);
	});
});
