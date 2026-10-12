// Review frame: the prompt contract shipped to the peer reviewer, plus the
// severity parser for its answer. Pure string work, no I/O.
import { describe, expect, it } from "vitest";
import { buildReviewFrame, parseFindings, type ReviewFile } from "../src/review-frame.js";

const file = (over: Partial<ReviewFile>): ReviewFile => ({
	path: "src/a.ts",
	status: "modified",
	patch: "@@ -1 +1 @@\n-old\n+new\n",
	...over,
});

const base = (over: Parameters<typeof buildReviewFrame>[0] extends never ? never : object) => over;

describe("buildReviewFrame", () => {
	const input = {
		mode: "diff" as const,
		backendNote: "git tree diff 3f2a..9d1c",
		tasks: ["add the frobnicator", "then make it fast"],
		claim: "Done. Frobnicator added, tests pass.",
		stat: " a.ts | 2 +-\n 1 file changed",
		files: [file({})],
		overflow: [],
		inlineCapChars: 20_000,
		maxFiles: 40,
		previousFindings: null,
		verifyFacts: [{ command: "npm test", ok: true }],
		filesEditedAfterLastVerify: false,
		preprompt: "Attack the premise first.",
	};

	it("opens with the preprompt, states the mode, and carries task + claim + stat + patch", () => {
		const frame = buildReviewFrame(input);
		expect(frame.startsWith("Attack the premise first.")).toBe(true);
		expect(frame).toContain("git tree diff 3f2a..9d1c");
		expect(frame).toContain("add the frobnicator");
		expect(frame).toContain("then make it fast");
		expect(frame).toContain("Done. Frobnicator added");
		expect(frame).toContain("a.ts | 2 +-");
		expect(frame).toContain("+new");
	});

	it("demands file:line evidence or an explicit not-found for every claim", () => {
		const frame = buildReviewFrame(input);
		expect(frame).toContain("file:line");
		expect(frame).toContain("not found");
	});

	it("requires the severity contract and a NO_BLOCKERS escape", () => {
		const frame = buildReviewFrame(input);
		expect(frame).toContain("BLOCKER");
		expect(frame).toContain("RISK");
		expect(frame).toContain("NIT");
		expect(frame).toContain("NO_BLOCKERS");
		expect(frame).toContain("UNVERIFIED");
	});

	it("names overflow paths past the itemization cap", () => {
		const frame = buildReviewFrame({
			...input,
			overflow: ["src/late1.ts", "src/late2.ts"],
		});
		expect(frame).toContain("not itemized");
		expect(frame).toContain("src/late1.ts");
		expect(frame).toContain("src/late2.ts");
	});

	it("caps inlined material and lists the remainder with a coverage demand", () => {
		const frame = buildReviewFrame({
			...input,
			files: [file({ path: "src/1.ts" }), file({ path: "src/2.ts" }), file({ path: "src/3.ts" })],
			inlineCapChars: 10,
		});
		expect(frame).toContain("not inlined");
		expect(frame).toContain("src/2.ts");
		expect(frame).toContain("coverage");
	});

	it("withholds secret-path content but names the file", () => {
		const frame = buildReviewFrame({
			...input,
			files: [file({ path: ".env.local", secret: true, patch: undefined })],
		});
		expect(frame).not.toContain("SECRET=1");
		expect(frame).toContain(".env.local");
		expect(frame.toLowerCase()).toContain("withheld");
	});

	it("lists binary files without content", () => {
		const frame = buildReviewFrame({ ...input, files: [file({ path: "logo.png", binary: true, patch: undefined })] });
		expect(frame).not.toContain("PNG");
		expect(frame).toContain("logo.png");
	});

	it("switches to verification mode when previous findings exist", () => {
		const frame = buildReviewFrame({
			...input,
			previousFindings: "BLOCKER: sql injection in login",
		});
		expect(frame).toContain("verification");
		expect(frame).toContain("BLOCKER: sql injection in login");
		expect(frame).toContain("no new NITs");
	});

	it("flags edits made after the last verify as unverified work", () => {
		const frame = buildReviewFrame({ ...input, filesEditedAfterLastVerify: true });
		expect(frame.toLowerCase()).toContain("after the last");
	});

	it("marks audit mode and demands the UNATTRIBUTABLE tag without git", () => {
		const frame = buildReviewFrame({
			...input,
			mode: "audit",
			backendNote: "no git repo: audit of current files; bash edits partly seen",
			files: [file({ patch: undefined, contentTail: "export const x = 1;\n" })],
		});
		expect(frame).toContain("audit");
		expect(frame).toContain("UNATTRIBUTABLE");
		expect(frame).toContain("export const x = 1;");
	});

	it("orders source before tests and never inlines deleted-file patches", () => {
		const frame = buildReviewFrame({
			...input,
			files: [file({ path: "test/a.spec.ts" }), file({ path: "src/core.ts", status: "modified" }), file({ path: "src/gone.ts", status: "deleted" })],
			inlineCapChars: 100_000,
			maxFiles: 40,
		});
		expect(frame.indexOf("src/core.ts")).toBeLessThan(frame.indexOf("test/a.spec.ts"));
	});
});

describe("parseFindings", () => {
	it("sorts findings by severity and records the clean escape", () => {
		const out = parseFindings([
			"RISK: the loop can spin",
			"NO_BLOCKERS",
			"NIT: rename x",
			"BLOCKER: auth bypass in check()",
		].join("\n"));
		expect(out.hasMarkers).toBe(true);
		expect(out.noBlockers).toBe(true);
		expect(out.blockers).toEqual(["BLOCKER: auth bypass in check()"]);
		expect(out.risks).toEqual(["RISK: the loop can spin"]);
		expect(out.nits).toEqual(["NIT: rename x"]);
	});

	it("parses bullets, bold markers, and next-line text", () => {
		const out = parseFindings([
			"- **BLOCKER:** sql injection in login",
			"1. RISK: the retry loop can spin",
			"NIT:",
			"rename x to y",
		].join("\n"));
		expect(out.hasMarkers).toBe(true);
		expect(out.blockers).toEqual(["BLOCKER: sql injection in login"]);
		expect(out.risks).toEqual(["RISK: the retry loop can spin"]);
		expect(out.nits).toEqual(["NIT: rename x to y"]);
	});

	it("treats marker-free output as not auto-injectable", () => {
		const out = parseFindings("Looks fine to me, ship it.");
		expect(out.hasMarkers).toBe(false);
		expect(out.blockers).toEqual([]);
	});

	it("does not mistake lookalike words for tags and takes one line per empty tag", () => {
		const out = parseFindings([
			"BLOCKERS: none found",
			"NITPICK: rename x",
			"RISK assessment: low overall",
			"BLOCKER:",
			"missing null check in login.ts:12",
			"more prose that is not a finding",
		].join("\n"));
		expect(out.blockers).toEqual(["BLOCKER: missing null check in login.ts:12"]);
		expect(out.risks).toEqual([]);
		expect(out.nits).toEqual([]);
	});

	it("captures UNVERIFIED lines separately from injectable findings", () => {
		const out = parseFindings("RISK: maybe broken\nUNVERIFIED: could not build without a diff");
		expect(out.risks).toEqual(["RISK: maybe broken"]);
		expect(out.unverified).toEqual(["could not build without a diff"]);
	});
});
