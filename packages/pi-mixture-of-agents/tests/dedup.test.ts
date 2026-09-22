import { describe, expect, it } from "vitest";
import { TurnCache, signature } from "../lib/dedup";
import type { AdvisoryMessage } from "../lib/transcript";
import type { Slot } from "../lib/types";

const slots: Slot[] = [
	{ provider: "google", model: "gemini-2.5-flash" },
	{ provider: "deepseek", model: "deepseek-v4-pro" },
];

const msgs: AdvisoryMessage[] = [
	{ role: "user", content: [{ type: "text", text: "hello" }] },
	{ role: "assistant", content: [{ type: "text", text: "hi" }] },
];

describe("signature", () => {
	it("is stable for identical input", () => {
		expect(signature(msgs, "default", slots)).toBe(signature(msgs, "default", slots));
	});

	it("changes when message text changes", () => {
		const changed: AdvisoryMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello!" }] },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		];
		expect(signature(changed, "default", slots)).not.toBe(signature(msgs, "default", slots));
	});

	it("changes when preset name changes", () => {
		expect(signature(msgs, "a", slots)).not.toBe(signature(msgs, "b", slots));
	});

	it("changes when slot set changes", () => {
		const fewer = [slots[0]];
		expect(signature(msgs, "default", fewer)).not.toBe(signature(msgs, "default", slots));
	});
});

describe("TurnCache", () => {
	it("returns null on miss", () => {
		const c = new TurnCache();
		expect(c.get("k")).toBeNull();
	});

	it("returns cached outputs on hit", () => {
		const c = new TurnCache();
		const out = [{ ok: true as const, slot: slots[0], text: "ref-output" }];
		c.set("k", out);
		const got = c.get("k");
		expect(got).toEqual(out);
	});

	it("returns a copy so callers cannot mutate the cache", () => {
		const c = new TurnCache();
		c.set("k", [{ ok: true, slot: slots[0], text: "orig" }]);
		const got = c.get("k")!;
		const first = got[0];
		if (first.ok) first.text = "mutated";
		const second = c.get("k")![0];
		if (second.ok) expect(second.text).toBe("orig");
	});

	it("clear() invalidates", () => {
		const c = new TurnCache();
		c.set("k", [{ ok: true, slot: slots[0], text: "x" }]);
		c.clear();
		expect(c.get("k")).toBeNull();
	});

	it("does not hit when outputs are empty", () => {
		const c = new TurnCache();
		c.set("k", []);
		expect(c.get("k")).toBeNull();
	});
});
