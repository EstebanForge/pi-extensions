import { describe, expect, it } from "vitest";
import { backgroundFlagText, buildTimeBudgetNotice, summarizePrompt } from "../src/text.js";

describe("summarizePrompt", () => {
	it("flattens whitespace and passes short prompts through", () => {
		expect(summarizePrompt("  review   src/foo.ts  ")).toBe("review src/foo.ts");
	});

	it("truncates long prompts with an ellipsis marker", () => {
		const long = "x".repeat(200);
		const out = summarizePrompt(long);
		expect(out.length).toBe(80);
		expect(out.endsWith("...")).toBe(true);
	});

	it("honors a custom max", () => {
		expect(summarizePrompt("abcdef", 5)).toBe("ab...");
	});
});

describe("buildTimeBudgetNotice", () => {
	it("formats minute-scale budgets with the task framing", () => {
		const out = buildTimeBudgetNotice(10 * 60_000);
		expect(out).toContain("[TIME BUDGET]");
		expect(out).toContain("about 10 minutes");
		expect(out).toContain("terminated at the limit");
		expect(out).toContain("complete final answer");
		expect(out).toContain("most valuable complete subset");
	});

	it("formats sub-minute budgets in seconds with the direct-answer framing", () => {
		const out = buildTimeBudgetNotice(45_000);
		expect(out).toContain("[TIME BUDGET]");
		expect(out).toContain("about 45 seconds");
		expect(out).not.toContain("minute");
		expect(out).toContain("direct, concise final answer immediately");
		expect(out).not.toContain("subset");
	});

	it("formats one-minute budgets in seconds (the seconds form owns everything under two minutes)", () => {
		const out = buildTimeBudgetNotice(60_000);
		expect(out).toContain("about 60 seconds");
		expect(out).toContain("direct, concise final answer immediately");
	});

	it("switches to the task framing at two minutes and above", () => {
		expect(buildTimeBudgetNotice(120_000)).toContain("about 2 minutes");
		expect(buildTimeBudgetNotice(119_999)).toContain("about 119 seconds");
	});

	it("never reports zero seconds", () => {
		expect(buildTimeBudgetNotice(400)).toBe("");
		expect(buildTimeBudgetNotice(999)).toBe("");
		expect(buildTimeBudgetNotice(1000)).toMatch(/about 1 second\./);
	});

	it("returns empty for absent or non-positive caps", () => {
		expect(buildTimeBudgetNotice(0)).toBe("");
		expect(buildTimeBudgetNotice(-5)).toBe("");
		expect(buildTimeBudgetNotice(Number.NaN)).toBe("");
	});
});

describe("backgroundFlagText", () => {
	const text = backgroundFlagText("sessionId");

	it("states the default, the wake notification, and the handle name", () => {
		expect(text).toContain("default false");
		expect(text).toContain("blocking");
		expect(text).toContain("runId");
		expect(text).toContain("message arrives");
		expect(text).toContain("sessionId");
		expect(text).toContain("Do not poll");
	});

	it("gates usage on ALL conditions and names the anti-pattern", () => {
		expect(text).toMatch(/\bALL\b/);
		expect(text).toContain("independent work");
		expect(text).toContain("late answer");
		expect(text).toContain("follow-up");
		expect(text).toContain("strictly better");
	});

	it("warns against write sandboxes on shared files", () => {
		expect(text).toMatch(/write access|write mode/i);
	});

	it("stays compact and obeys the character rules", () => {
		const words = text.split(/\s+/).length;
		expect(words).toBeLessThanOrEqual(130);
		expect(text).not.toMatch(/[—–]/);
		expect(text).not.toContain("·");
	});

	it("substitutes the per-tool handle name", () => {
		expect(backgroundFlagText("conversationId")).toContain("conversationId");
		expect(backgroundFlagText("conversationId")).not.toContain("sessionId");
	});
});
