import { describe, expect, it } from "vitest";
import { trimForReferences } from "../lib/transcript";

describe("trimForReferences", () => {
	it("keeps user and assistant text only", () => {
		const out = trimForReferences([
			{ role: "system", content: "sys" },
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		]);
		expect(out).toEqual([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		]);
	});

	it("drops toolCall and toolResult blocks but keeps adjacent text", () => {
		const out = trimForReferences([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "thinking..." },
					{ type: "toolCall", id: "1", name: "read", arguments: {} },
				],
			},
			{ role: "toolResult", content: [{ type: "text", text: "file contents" }] },
		]);
		// assistant text kept; toolCall dropped; toolResult role dropped entirely
		expect(out).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "thinking..." }] },
		]);
	});

	it("accepts string content (no content array)", () => {
		const out = trimForReferences([{ role: "user", content: "plain string" }]);
		expect(out).toEqual([
			{ role: "user", content: [{ type: "text", text: "plain string" }] },
		]);
	});

	it("omits messages whose text is empty/whitespace", () => {
		const out = trimForReferences([
			{ role: "user", content: "   " },
			{ role: "assistant", content: [{ type: "text", text: "" }] },
			{ role: "user", content: [{ type: "text", text: "kept" }] },
		]);
		expect(out).toHaveLength(1);
		expect(out[0].content[0].text).toBe("kept");
	});

	it("is deterministic: same input -> same output (determines dedup stability)", () => {
		const msgs = [
			{ role: "user", content: [{ type: "text", text: "abc" }] },
			{ role: "assistant", content: [{ type: "text", text: "def" }] },
		];
		expect(trimForReferences(msgs)).toEqual(trimForReferences(msgs));
	});

	it("handles null/undefined/empty gracefully", () => {
		expect(trimForReferences(null)).toEqual([]);
		expect(trimForReferences(undefined)).toEqual([]);
		expect(trimForReferences([])).toEqual([]);
	});

	it("ignores non-object entries", () => {
		const out = trimForReferences([
			null,
			"garbage",
			{ role: "user", content: [{ type: "text", text: "x" }] },
		] as unknown as Parameters<typeof trimForReferences>[0]);
		expect(out).toHaveLength(1);
	});
});
