import { describe, it, expect } from "vitest";
import {
	numberDiff,
	compilePlan,
	manifestLine,
	type Submission,
	type EditPlan,
} from "../extensions/compiler.js";

// A diff with NO imports (so the default-keep contract is clean) and 4 changed
// lines: -oldCall, +newCall, +x, +y.
const SAMPLE = [
	"diff --git a/foo.go b/foo.go",
	"--- a/foo.go",
	"+++ b/foo.go",
	"@@ -1,3 +1,4 @@",
	" package main",
	"-oldCall()",
	"+newCall()",
	"+\tx := 1",
	"+\ty := 2",
	" }",
].join("\n");

function sub(p: Partial<EditPlan> & { summary?: string } = {}): Submission {
	return {
		remove: p.remove ?? [],
		replace: p.replace ?? [],
		fold: p.fold ?? [],
		summary: p.summary ?? "s",
	};
}

describe("numberDiff", () => {
	it("numbers every line 1-indexed with a | gutter", () => {
		expect(numberDiff("a\nb\nc")).toBe("1|a\n2|b\n3|c");
	});
	it("drops a single trailing newline", () => {
		expect(numberDiff("a\nb\n")).toBe("1|a\n2|b");
	});
	it("pads the gutter to the widest number", () => {
		const n = numberDiff(Array.from({ length: 10 }, () => "x").join("\n"));
		expect(n.split("\n")[0]).toBe(" 1|x");
		expect(n.split("\n")[9]).toBe("10|x");
	});
});

describe("compilePlan — default keep", () => {
	it("keeps every line when the plan is empty (no imports here)", () => {
		const r = compilePlan(SAMPLE, sub());
		expect(r.abridged).toBe(SAMPLE);
		expect(r.markers).toBe(0);
		expect(r.totalChanged).toBe(4);
		expect(r.visibleChanged).toBe(4);
		expect(manifestLine(r)).toBe("kept 4/4 changed lines");
	});
});

describe("compilePlan — remove", () => {
	it("removes a range and inserts one gap marker", () => {
		const r = compilePlan(SAMPLE, sub({ remove: [{ start: 7, end: 8 }] }));
		expect(r.abridged).toContain("\u22ef\u22ef 2 lines elided \u22ef\u22ef");
		expect(r.markers).toBe(1);
		expect(r.visibleChanged).toBe(2); // oldCall + newCall
		expect(r.removedChanged).toBe(2);
		expect(r.abridged).not.toContain("x := 1");
	});
});

describe("compilePlan — fold", () => {
	it("collapses a same-polarity range into one indentation-preserving row", () => {
		const r = compilePlan(SAMPLE, sub({ fold: [{ start: 8, end: 9 }] }));
		expect(r.abridged).toContain("+\t...");
		expect(r.folds).toBe(1);
		expect(r.foldedChanged).toBe(2);
		expect(r.visibleChanged).toBe(3); // oldCall + newCall + 1 fold row
		expect(r.markers).toBe(0);
		expect(r.abridged).not.toContain("x := 1");
	});
});

describe("compilePlan — replace", () => {
	it("elides within a line via a deletion-only projection", () => {
		const r = compilePlan(
			SAMPLE,
			sub({ replace: [{ line: 7, old: "newCall()", new: "new...()" }] }),
		);
		expect(r.abridged).toContain("+new...()");
		expect(r.visibleChanged).toBe(4);
	});
});

describe("compilePlan — fidelity", () => {
	it("emits only real original lines (kept lines are verbatim)", () => {
		const r = compilePlan(SAMPLE, sub({ remove: [{ start: 7, end: 8 }] }));
		const original = new Set(SAMPLE.split("\n"));
		for (const out of r.abridged.split("\n")) {
			if (out.startsWith("\u22ef")) continue; // gap marker
			expect(original.has(out)).toBe(true);
		}
	});
});

describe("compilePlan — mandatory imports", () => {
	const IMPORT_DIFF = [
		"diff --git a/a.go b/a.go",
		"--- a/a.go",
		"+++ b/a.go",
		"@@ -1,2 +1,3 @@",
		'-import "fmt"',
		'+import "os"',
		'+fmt.Println("hi")',
	].join("\n");
	const IMPORT_ONLY = [
		"diff --git a/a.go b/a.go",
		"--- a/a.go",
		"+++ b/a.go",
		"@@ -1,1 +1,1 @@",
		'-import "fmt"',
		'+import "os"',
	].join("\n");

	it("strips imports silently (no elision marker)", () => {
		const r = compilePlan(IMPORT_DIFF, sub());
		expect(r.abridged).not.toContain("import");
		expect(r.abridged).not.toContain("elided");
		expect(r.abridged).toContain('+fmt.Println("hi")');
		expect(r.markers).toBe(0);
		expect(r.totalChanged).toBe(3);
		expect(r.visibleChanged).toBe(1);
		expect(manifestLine(r)).toBe("kept 1/3 changed lines");
	});

	it("reports all-elided when a file is import-only", () => {
		const r = compilePlan(IMPORT_ONLY, sub());
		expect(r.allElided).toBe(true);
		expect(r.abridged).toBe("");
		expect(manifestLine(r)).toBe("elided all 2 changed lines");
	});
});

describe("compilePlan — manifest files", () => {
	it("counts files when more than one", () => {
		const two = [
			"diff --git a/a.go b/a.go",
			"--- a/a.go",
			"+++ b/a.go",
			"@@ -1,1 +1,1 @@",
			"+x := 1",
			"diff --git a/b.go b/b.go",
			"--- a/b.go",
			"+++ b/b.go",
			"@@ -1,1 +1,1 @@",
			"+y := 2",
		].join("\n");
		const r = compilePlan(two, sub());
		expect(r.files).toEqual({ kept: 2, total: 2 });
		expect(manifestLine(r)).toBe("kept 2/2 changed lines in 2/2 files");
	});
});

describe("compilePlan — fail visibly", () => {
	it("rejects out-of-bounds remove", () => {
		expect(() => compilePlan(SAMPLE, sub({ remove: [{ start: 1, end: 999 }] }))).toThrow(
			/past end of diff/,
		);
	});
	it("rejects remove with start after end", () => {
		expect(() => compilePlan(SAMPLE, sub({ remove: [{ start: 8, end: 5 }] }))).toThrow(
			/invalid inclusive range/,
		);
	});
	it("rejects a fold of fewer than two lines", () => {
		expect(() => compilePlan(SAMPLE, sub({ fold: [{ start: 7, end: 7 }] }))).toThrow(
			/at least two lines/,
		);
	});
	it("rejects a fold across mixed diff markers", () => {
		expect(() => compilePlan(SAMPLE, sub({ fold: [{ start: 5, end: 6 }] }))).toThrow(
			/mixed diff markers/,
		);
	});
	it("rejects a non-projection replacement", () => {
		expect(() =>
			compilePlan(SAMPLE, sub({ replace: [{ line: 6, old: "newCall()", new: "xyz()" }] })),
		).toThrow(/must match all of old/);
	});
	it("rejects a replacement that does not elide", () => {
		expect(() =>
			compilePlan(SAMPLE, sub({ replace: [{ line: 6, old: "newCall()", new: "newCall()" }] })),
		).toThrow(/must elide/);
	});
	it("rejects a replacement whose old is not unique on the line", () => {
		const dup = [
			"diff --git a/a.go b/a.go",
			"--- a/a.go",
			"+++ b/a.go",
			"@@ -1,1 +1,1 @@",
			"+foo() + foo()",
		].join("\n");
		expect(() =>
			compilePlan(dup, sub({ replace: [{ line: 5, old: "foo()", new: "f...()" }] })),
		).toThrow(/exactly once/);
	});
	it("rejects an empty summary", () => {
		expect(() => compilePlan(SAMPLE, sub({ summary: "   " }))).toThrow(/summary must not be empty/);
	});
});
