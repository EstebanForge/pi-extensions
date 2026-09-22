/**
 * Dedup cache-hit path for buildAggregatorMessages (session mode).
 *
 * Second call within a turn with an unchanged advisory must reuse the cached
 * reference outputs and NOT call pi-ai again. This is the feature
 * justification for TurnCache; before this test the branch was untested.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TurnCache } from "../lib/dedup";
import type { NormalizedPreset, SlotContext } from "../lib/types";

const state = { complete: vi.fn() };
vi.mock("@earendil-works/pi-ai/compat", () => ({
	complete: (...args: unknown[]) => state.complete(...args),
}));

const { buildAggregatorMessages } = await import("../lib/stream-facade");

const preset: NormalizedPreset = {
	reference_models: [{ provider: "p", model: "ref1" }],
	aggregator: { provider: "p", model: "agg" },
	reference_temperature: 0.6,
	aggregator_temperature: 0.4,
	max_tokens: 4096,
	enabled: true,
};

const ctx: SlotContext = {
	modelRegistry: {
		find: () => ({ id: "m", provider: "p" }),
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k", headers: undefined, env: undefined }),
	},
};

beforeEach(() => {
	state.complete.mockReset();
	// Each call returns one text block so the ref is "usable".
	state.complete.mockResolvedValue({ content: [{ type: "text", text: "ref answer" }] });
});

describe("buildAggregatorMessages cache-hit", () => {
	it("runs references once and reuses the cache on a second identical call", async () => {
		const cache = new TurnCache();
		const messages = [{ role: "user", content: [{ type: "text", text: "same question" }] }];

		const first = await buildAggregatorMessages({
			preset, presetName: "default", messages, ctx, cache,
		});
		const second = await buildAggregatorMessages({
			preset, presetName: "default", messages, ctx, cache,
		});

		expect(state.complete).toHaveBeenCalledTimes(1); // cache hit on 2nd
		// Both produce the same injected guidance; second is not undefined/null.
		expect(second).toEqual(first);
		expect(second.length).toBeGreaterThan(0);
	});

	it("re-runs references when the advisory changes (cache miss)", async () => {
		const cache = new TurnCache();
		const m1 = [{ role: "user", content: [{ type: "text", text: "question A" }] }];
		const m2 = [{ role: "user", content: [{ type: "text", text: "question B" }] }];

		await buildAggregatorMessages({ preset, presetName: "default", messages: m1, ctx, cache });
		await buildAggregatorMessages({ preset, presetName: "default", messages: m2, ctx, cache });

		expect(state.complete).toHaveBeenCalledTimes(2);
	});

	it("skips references entirely when the preset is disabled", async () => {
		const cache = new TurnCache();
		const messages = [{ role: "user", content: [{ type: "text", text: "q" }] }];
		const disabled: NormalizedPreset = { ...preset, enabled: false };

		const out = await buildAggregatorMessages({ preset: disabled, presetName: "default", messages, ctx, cache });
		expect(state.complete).not.toHaveBeenCalled();
		expect(out).toBe(messages); // returned unchanged
	});

	it("passes messages through unchanged when every reference fails", async () => {
		const cache = new TurnCache();
		const messages = [{ role: "user", content: [{ type: "text", text: "q" }] }];
		// Every ref fails: complete rejects, so hasUsableGuidance stays false
		// and the guidance block is omitted (aggregator runs alone).
		state.complete.mockReset();
		state.complete.mockRejectedValue(new Error("boom"));

		const out = await buildAggregatorMessages({ preset, presetName: "default", messages, ctx, cache });
		expect(out).toBe(messages); // unchanged: no guidance appended
	});
});
