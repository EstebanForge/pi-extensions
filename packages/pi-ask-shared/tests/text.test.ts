import { describe, expect, it } from "vitest";
import { backgroundFlagText, summarizePrompt } from "../src/text.js";

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
