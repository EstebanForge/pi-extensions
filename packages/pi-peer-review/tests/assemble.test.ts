// Payload assembly characterization: the consult prompt sent to the reviewer
// and the notice envelope injected into the executor transcript.
import { describe, expect, it } from "vitest";
import { buildConsultPrompt, buildNotice, centerTruncate } from "../src/assemble.js";

const baseInput = {
	triggerKey: "exec:npm",
	failureCount: 3,
	recentFailures: [
		{ command: "npm test", exitCode: 1, stderrTail: "3 failed, 2 passed" },
	],
	transcriptTurns: [
		{ index: 7, tool: "exec", summary: "$ npm test", output: "FAIL src/x.test.ts" },
	],
	settings: { preprompt: "", contextMaxTurns: 4, maxOutputCharsPerTurn: 4000 },
};

describe("buildConsultPrompt", () => {
	it("frames the review as a non-debatable system notice", () => {
		const p = buildConsultPrompt(baseInput);
		expect(p).toContain("SYSTEM NOTICE");
		expect(p).toContain("do not debate");
		expect(p).toContain("exec:npm");
		expect(p).toContain("3 consecutive");
		expect(p).toContain("npm test");
		expect(p).toContain("3 failed, 2 passed");
	});

	it("prepends the configured preprompt when set", () => {
		const p = buildConsultPrompt({
			...baseInput,
			settings: { ...baseInput.settings, preprompt: "Be terse. Name exact commands." },
		});
		expect(p.startsWith("Be terse. Name exact commands.\n\n")).toBe(true);
	});

	it("omits empty preprompt and failure stderr without residue", () => {
		const p = buildConsultPrompt({
			...baseInput,
			recentFailures: [{ command: "npm test", exitCode: 1, stderrTail: "" }],
			settings: { ...baseInput.settings, preprompt: "" },
		});
		expect(p).not.toContain("undefined");
		expect(p).not.toContain("null");
	});

	it("caps per-turn output via center truncation", () => {
		const long = "a".repeat(3000) + "MIDDLE" + "z".repeat(3000);
		const p = buildConsultPrompt({
			...baseInput,
			transcriptTurns: [{ index: 1, tool: "exec", summary: "$ big", output: long }],
			settings: { ...baseInput.settings, maxOutputCharsPerTurn: 100 },
		});
		// Head + tail kept, middle dropped with an honest marker (5946 = 6006 - 60).
		expect(p).toContain("truncated 5946 chars");
		expect(p).not.toContain("MIDDLE");
		expect(p).not.toContain("a".repeat(500));
	});
});

describe("centerTruncate", () => {
	it("returns short text untouched", () => {
		expect(centerTruncate("short", 100)).toBe("short");
	});

	it("keeps head and tail with a marker", () => {
		const out = centerTruncate("H".repeat(60) + "X".repeat(40) + "T".repeat(60), 50);
		expect(out.startsWith("HHHH")).toBe(true);
		expect(out.endsWith("TTTT")).toBe(true);
		expect(out).toMatch(/truncated \d+ chars/);
		// The dropped middle is gone by contract.
		expect(out).not.toContain("XX");
	});
});

describe("buildNotice", () => {
	it("wraps the reviewer answer in the rigid executor envelope", () => {
		const n = buildNotice("Try removing the stale lockfile.");
		expect(n).toContain("[SYSTEM NOTICE");
		expect(n).toContain("do not debate this notice");
		expect(n).toContain("Try removing the stale lockfile.");
	});
});
