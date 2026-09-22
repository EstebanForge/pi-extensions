import { describe, it, expect } from "vitest";
import { analyzeDiff } from "../extensions/diff.js";
import { mandatoryImportMask } from "../extensions/imports.js";
import { compilePlan, manifestLine, type Submission } from "../extensions/compiler.js";

function sub(p: Partial<Submission> & { summary?: string } = {}): Submission {
	return { remove: p.remove ?? [], replace: p.replace ?? [], fold: p.fold ?? [], summary: p.summary ?? "s" };
}

// --- diff.ts: count-aware hunk boundaries -------------------------------------
describe("review: count-aware hunk boundaries", () => {
	it("classifies a mid-hunk --- /+++ pair as source, not file headers", () => {
		// A hunk whose body literally adds lines starting with `--- a/` and `+++ b/`
		// (e.g. editing a file that contains a diff). Counts are known, so the pair
		// must stay classified as hunk changes, not end the hunk as file markers.
		const diff = [
			"diff --git a/patch.md b/patch.md",
			"--- a/patch.md",
			"+++ b/patch.md",
			"@@ -1,2 +1,2 @@",
			" context",
			"--- a/other.go",
			"+++ b/other.go",
		].join("\n");
		const a = analyzeDiff(diff);
		expect(a.kinds[5]).toBe("hunkChange"); // --- a/other.go
		expect(a.kinds[6]).toBe("hunkChange"); // +++ b/other.go
	});
});

// --- imports.ts: per-file framing ---------------------------------------------
describe("review: import framing keeps mixed files", () => {
	it("does not drop a file's metadata when only one of its hunks is import-only", () => {
		const diff = [
			"diff --git a/app.ts b/app.ts",
			"--- a/app.ts",
			"+++ b/app.ts",
			"@@ -1,1 +1,1 @@",
			'-import { a } from "./a";',
			'-import { b } from "./b";',
			"@@ -10,1 +10,1 @@",
			"-old()",
			"+new()",
		].join("\n");
		const m = mandatoryImportMask(analyzeDiff(diff));
		// File metadata (diff --git / --- / +++) is NOT hidden: the file has a real change.
		expect(m[0]).toBe(false);
		expect(m[1]).toBe(false);
		expect(m[2]).toBe(false);
		// The import-only hunk's lines (and its @@ header) ARE hidden.
		expect(m[3]).toBe(true); // @@ of import hunk
		expect(m[4]).toBe(true);
		expect(m[5]).toBe(true);
		// The real-change hunk is untouched.
		expect(m[7]).toBe(false);
		expect(m[8]).toBe(false);
	});
});

// --- imports.ts: multiline fallback -------------------------------------------
describe("review: multiline import fallback", () => {
	it("does not eat following declarations when an import block is unterminated", () => {
		// `import {` with no closing `} from "..."` must NOT swallow the rest of the
		// side; the function after it stays visible.
		const diff = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,1 +1,5 @@",
			"+import {",
			"+  Alpha,",
			"+  Beta",
			"+}",
			"+function realCode() {}",
		].join("\n");
		const m = mandatoryImportMask(analyzeDiff(diff));
		expect(m[8]).toBe(false); // function realCode() {} not eaten
	});
});

// --- compiler.ts: remove over import is a no-op -------------------------------
describe("review: remove over import is a no-op", () => {
	const diff = [
		"diff --git a/a.go b/a.go",
		"--- a/a.go",
		"+++ b/a.go",
		"@@ -1,3 +1,3 @@",
		'-import "fmt"',
		"-oldChurn()",
		"+newCode()",
	].join("\n");

	it("does not throw when a remove range covers an auto-stripped import", () => {
		expect(() => compilePlan(diff, sub({ remove: [{ start: 5, end: 6 }] }))).not.toThrow();
	});

	it("counts only model-removed lines in the elision marker (imports excluded)", () => {
		const r = compilePlan(diff, sub({ remove: [{ start: 5, end: 6 }] }));
		expect(r.abridged).toContain("1 line elided");
		expect(r.abridged).not.toContain("2 lines elided");
		expect(r.abridged).not.toContain("import");
		expect(r.markers).toBe(1);
		expect(r.visibleChanged).toBe(1); // +newCode()
	});
});

// --- compiler.ts: structural restore ------------------------------------------
describe("review: structural restore", () => {
	it("restores a hunk header the model removed when body lines survive", () => {
		const diff = [
			"diff --git a/a.go b/a.go",
			"--- a/a.go",
			"+++ b/a.go",
			"@@ -1,2 +1,2 @@",
			" context",
			"+newCode()",
		].join("\n");
		// Model removes the @@ header (line 4) but the body survives: the header
		// is restored so the reading diff is never orphaned.
		const r = compilePlan(diff, sub({ remove: [{ start: 4, end: 4 }] }));
		expect(r.abridged).toContain("@@ -1,2 +1,2 @@");
		expect(r.abridged).toContain("+newCode()");
		expect(r.abridged).toContain("diff --git a/a.go");
	});
});

// --- compiler.ts: structural elision + fold together -------------------------
describe("review: structural elision and fold compose", () => {
	it("rebuilds a replaced line from old's slices and folds repetition", () => {
		const diff = [
			"diff --git a/a.go b/a.go",
			"--- a/a.go",
			"+++ b/a.go",
			"@@ -1,4 +1,4 @@",
			"-oldCall(a, b, c)",
			"+newCall(a, b, c)",
			"+\tx := 1",
			"+\ty := 2",
		].join("\n");
		const r = compilePlan(
			diff,
			sub({
				replace: [{ line: 6, old: "newCall(a, b, c)", new: "newCall(...)" }],
				fold: [{ start: 7, end: 8 }],
			}),
		);
		// The replace output is the structural projection, not model text.
		expect(r.abridged).toContain("+newCall(...)");
		// The fold row preserves the shared indent.
		expect(r.abridged).toContain("+\t...");
		expect(r.abridged).not.toContain("x := 1");
		expect(manifestLine(r)).toBe("kept 3/4 changed lines");
	});
});
