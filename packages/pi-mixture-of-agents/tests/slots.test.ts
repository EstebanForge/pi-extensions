/**
 * Unit tests for lib/slots.ts without touching the network or pi-ai.
 *
 * `@earendil-works/pi-ai/compat` is mocked so complete is a stub we drive
 * from each test; slot resolution goes through a fake modelRegistry.find.
 * drive from each test. Covers the four production failure modes that had no
 * offline coverage: recursion guard, catalog miss, auth failure, empty
 * response — plus the aggregator recursion guard.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// Stub state. Reset before each test so calls don't bleed across cases.
const mockModel = { id: "m", provider: "p" };
const state = {
	complete: vi.fn(),
};

vi.mock("@earendil-works/pi-ai/compat", () => ({
	complete: (...args: unknown[]) => state.complete(...args),
}));

// Import AFTER vi.mock is registered (vitest hoists vi.mock above imports).
const { makeCallSlot, callAggregator } = await import("../lib/slots");
import type { SlotContext } from "../lib/types";

function fakeCtx(opts: { authOk?: boolean; model?: unknown } = {}): SlotContext {
	const { authOk = true } = opts;
	return {
		modelRegistry: {
			find: vi.fn(() => opts.model),
			getApiKeyAndHeaders: async (_model: unknown) =>
				authOk
					? { ok: true as const, apiKey: "k", headers: undefined, env: undefined }
					: { ok: false as const, error: "no creds" },
		},
	};
}

const slot = { provider: "p", model: "m" };

beforeEach(() => {
	state.complete.mockReset();
});

describe("makeCallSlot", () => {
	it("rejects a recursive moa: slot without touching the registry", async () => {
		const ctx = fakeCtx({ model: mockModel });
		const call = makeCallSlot(ctx);
		await expect(call({ provider: "moa", model: "x" }, "hi", {})).rejects.toThrow(/recursively reference MoA/);
		expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
	});

	it("throws when the model is not in the catalog", async () => {
		const call = makeCallSlot(fakeCtx({ model: undefined }));
		await expect(call(slot, "hi", {})).rejects.toThrow(/not in catalog/);
	});

	it("throws on auth failure", async () => {
		const call = makeCallSlot(fakeCtx({ authOk: false, model: mockModel }));
		await expect(call(slot, "hi", {})).rejects.toThrow("no creds");
		expect(state.complete).not.toHaveBeenCalled();
	});

	it("throws on an empty response", async () => {
		state.complete.mockResolvedValue({ content: [] });
		const call = makeCallSlot(fakeCtx({ model: mockModel }));
		await expect(call(slot, "hi", {})).rejects.toThrow(/empty response/);
	});

	it("returns joined text on a successful call", async () => {
		state.complete.mockResolvedValue({
			content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }],
		});
		const call = makeCallSlot(fakeCtx({ model: mockModel }));
		await expect(call(slot, "hi", {})).resolves.toBe("hello\nworld");
	});
});

describe("callAggregator", () => {
	it("rejects a recursive moa: aggregator", async () => {
		const ctx = fakeCtx({ model: mockModel });
		await expect(
			callAggregator({ provider: "moa", model: "x" }, ctx, { messages: [] }),
		).rejects.toThrow(/aggregator cannot be a MoA preset/);
		expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
	});

	it("throws when the aggregator model is not in the catalog", async () => {
		await expect(callAggregator(slot, fakeCtx({ model: undefined }), { messages: [] })).rejects.toThrow(/not in catalog/);
	});

	it("throws on auth failure", async () => {
		await expect(
			callAggregator(slot, fakeCtx({ authOk: false, model: mockModel }), { messages: [] }),
		).rejects.toThrow("no creds");
		expect(state.complete).not.toHaveBeenCalled();
	});

	it("forwards a successful aggregator response", async () => {
		state.complete.mockResolvedValue({ content: [{ type: "text", text: "final answer" }] });
		const resp = await callAggregator(slot, fakeCtx({ model: mockModel }), { messages: [] });
		expect(state.complete).toHaveBeenCalledTimes(1);
		expect(resp.content).toEqual([{ type: "text", text: "final answer" }]);
	});
});
