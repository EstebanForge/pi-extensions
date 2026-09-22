import { describe, expect, it, vi } from "vitest";
import { aggregate, runPresetTurn, runReferences } from "../lib/engine";
import { GUIDANCE_HEADER } from "../lib/prompts";
import type { AdvisoryMessage } from "../lib/transcript";
import type { CallSlot, NormalizedPreset, ReferenceResult, Slot } from "../lib/types";

const A: Slot = { provider: "google", model: "gemini-2.5-flash" };
const B: Slot = { provider: "deepseek", model: "deepseek-v4-pro" };
const AGG: Slot = { provider: "claude-bridge", model: "claude-opus-4-8" };

/** Build a mock CallSlot. Map slot -> behavior: a string response or an Error to throw. */
function mockCall(spec: Partial<Record<string, string | Error>>): CallSlot {
	return async (slot, instruction, _opts) => {
		const key = `${slot.provider}/${slot.model}`;
		const behavior = spec[key];
		if (behavior instanceof Error) throw behavior;
		if (behavior !== undefined) return behavior;
		// Default: echo the instruction so we can assert it was threaded through.
		return `(${key}) ${instruction.slice(0, 20)}`;
	};
}

const advisory: AdvisoryMessage[] = [
	{ role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
];

function makePreset(overrides: Partial<NormalizedPreset> = {}): NormalizedPreset {
	return {
		reference_models: [A, B],
		aggregator: AGG,
		reference_temperature: 0.6,
		aggregator_temperature: 0.4,
		max_tokens: 4096,
		enabled: true,
		...overrides,
	};
}

describe("runReferences", () => {
	it("preserves slot order in results", async () => {
		const results = await runReferences({
			slots: [A, B],
			instruction: "turn",
			call: mockCall({ [`${A.provider}/${A.model}`]: "a-out", [`${B.provider}/${B.model}`]: "b-out" }),
		});
		expect(results.map((r) => r.slot)).toEqual([A, B]);
		expect(results.every((r) => r.ok)).toBe(true);
	});

	it("tolerates a failing reference without aborting siblings", async () => {
		const results = await runReferences({
			slots: [A, B],
			instruction: "turn",
			call: mockCall({ [`${A.provider}/${A.model}`]: new Error("boom"), [`${B.provider}/${B.model}`]: "b-out" }),
		});
		expect(results).toHaveLength(2);
		expect(results[0].ok).toBe(false);
		if (!results[0].ok) expect(results[0].error).toBe("boom");
		expect(results[1].ok).toBe(true);
	});

	it("threads instruction into each call", async () => {
		const call = vi.fn(async () => "out") as unknown as CallSlot;
		await runReferences({ slots: [A], instruction: "THE-INSTRUCTION", call });
		expect(call).toHaveBeenCalledWith(
			A,
			"THE-INSTRUCTION",
			expect.objectContaining({ temperature: undefined, maxTokens: undefined }),
		);
	});

	it("threads temperature and maxTokens from args", async () => {
		const call = vi.fn(async () => "out") as unknown as CallSlot;
		await runReferences({ slots: [A], instruction: "x", call, temperature: 0.7, maxTokens: 512 });
		expect(call).toHaveBeenCalledWith(A, "x", expect.objectContaining({ temperature: 0.7, maxTokens: 512 }));
	});

	it("emits ref-start (per slot) then ref-done/ref-failed; one fail one success", async () => {
		const onProgress = vi.fn();
		await runReferences({
			slots: [A, B],
			instruction: "x",
			call: mockCall({ [`${A.provider}/${A.model}`]: new Error("fail") }),
			onProgress,
		});
		// Parallel dispatch: both ref-start fire before any completion.
		const phases = onProgress.mock.calls.map((c) => c[2]);
		expect(phases.filter((p) => p === "ref-start")).toHaveLength(2);
		expect(phases).toContain("ref-failed");
		expect(phases).toContain("ref-done");
		expect(phases).toHaveLength(4);
	});

	it("propagates abort signal into the call options", async () => {
		const call = vi.fn(async () => "out") as unknown as CallSlot;
		const ac = new AbortController();
		await runReferences({ slots: [A], instruction: "x", call, signal: ac.signal });
		expect(call).toHaveBeenCalledWith(A, "x", expect.objectContaining({ signal: ac.signal }));
	});
});

describe("aggregate", () => {
	it("wraps aggregator output with the guidance header in oneshot mode", async () => {
		const guidance = await aggregate({
			refs: [{ ok: true, slot: A, text: "refA" }],
			mode: "oneshot",
			instruction: "Q",
			call: mockCall({ [`${AGG.provider}/${AGG.model}`]: "next steps: do X" }),
			aggregator: AGG,
		});
		expect(guidance.startsWith(GUIDANCE_HEADER)).toBe(true);
		expect(guidance).toContain("next steps: do X");
	});

	it("returns the raw answer in session mode (no guidance wrapper)", async () => {
		const out = await aggregate({
			refs: [{ ok: true, slot: A, text: "refA" }],
			mode: "session",
			instruction: "Q",
			call: mockCall({ [`${AGG.provider}/${AGG.model}`]: "the answer is 4" }),
			aggregator: AGG,
		});
		expect(out).toBe("the answer is 4");
		expect(out.startsWith(GUIDANCE_HEADER)).toBe(false);
	});

	it("calls the aggregator alone (no guidance) when no usable refs", async () => {
		const call = mockCall({ [`${AGG.provider}/${AGG.model}`]: "solo answer" });
		const out = await aggregate({
			refs: [{ ok: false, slot: A, error: "all failed" }],
			mode: "session",
			instruction: "Q",
			call,
			aggregator: AGG,
		});
		expect(out).toBe("solo answer");
	});
});

describe("runPresetTurn", () => {
	it("fans out refs then aggregates for an enabled preset", async () => {
		const call = mockCall({
			[`${A.provider}/${A.model}`]: "refA",
			[`${B.provider}/${B.model}`]: "refB",
			[`${AGG.provider}/${AGG.model}`]: "synthesis",
		});
		const { refs, guidance } = await runPresetTurn({
			preset: makePreset(), advisory, call, mode: "session",
		});
		expect(refs.map((r: ReferenceResult) => r.slot)).toEqual([A, B]);
		expect(guidance).toBe("synthesis");
	});

	it("skips refs entirely when enabled:false (aggregator alone)", async () => {
		const call = mockCall({ [`${AGG.provider}/${AGG.model}`]: "solo" });
		const onProgress = vi.fn();
		const { refs, guidance } = await runPresetTurn({
			preset: makePreset({ enabled: false, reference_models: [A, B] }),
			advisory, call, mode: "session", onProgress,
		});
		expect(refs).toEqual([]);
		expect(guidance).toBe("solo");
		// Only the aggregating phase, no ref-* phases.
		expect(onProgress.mock.calls.map((c) => c[2])).toEqual(["aggregating"]);
	});

	it("aggregator still runs when all refs fail", async () => {
		const call = mockCall({
			[`${A.provider}/${A.model}`]: new Error("a-fail"),
			[`${B.provider}/${B.model}`]: new Error("b-fail"),
			[`${AGG.provider}/${AGG.model}`]: "best-effort answer",
		});
		const { refs, guidance } = await runPresetTurn({
			preset: makePreset(), advisory, call, mode: "session",
		});
		expect(refs.every((r: ReferenceResult) => !r.ok)).toBe(true);
		expect(guidance).toBe("best-effort answer");
	});

	it("continues when one ref fails mid-fan-out", async () => {
		const call = mockCall({
			[`${A.provider}/${A.model}`]: "refA",
			[`${B.provider}/${B.model}`]: new Error("b-fail"),
			[`${AGG.provider}/${AGG.model}`]: "synthesis",
		});
		const { refs } = await runPresetTurn({ preset: makePreset(), advisory, call, mode: "session" });
		expect(refs[0].ok).toBe(true);
		expect(refs[1].ok).toBe(false);
	});
});

describe("runtime recursion guard", () => {
	// moa_loop.py:142 safety net behind the config-time guard. A moa:* slot
	// must surface as a skipped/failed reference, never a hard crash.
	it("a moa:* reference slot surfaces as a labelled failure (not a crash)", async () => {
		const moaSlot: Slot = { provider: "moa", model: "default" };
		// A call impl that mirrors makeCallSlot's guard (avoids needing the live
		// model registry). The engine sees the throw and folds it into results.
		const call: CallSlot = async (slot) => {
			if (slot.provider.toLowerCase() === "moa") {
				throw new Error("[skipped: MoA presets cannot recursively reference MoA]");
			}
			return "ok";
		};
		const results = await runReferences({ slots: [moaSlot], instruction: "x", call });
		expect(results).toHaveLength(1);
		expect(results[0].ok).toBe(false);
		if (!results[0].ok) expect(results[0].error).toContain("[skipped:");
	});

	it("a mix of moa:* and normal slots runs the normal one and skips the recursive one", async () => {
		const moaSlot: Slot = { provider: "moa", model: "default" };
		const normal: Slot = { provider: "google", model: "gemini-2.5-flash" };
		const call: CallSlot = async (slot) => {
			if (slot.provider.toLowerCase() === "moa") {
				throw new Error("[skipped: MoA presets cannot recursively reference MoA]");
			}
			return "real-output";
		};
		const results = await runReferences({ slots: [moaSlot, normal], instruction: "x", call });
		expect(results[0].ok).toBe(false);
		expect(results[1].ok).toBe(true);
	});

	it("aggregate still runs when every reference was skipped (recursion or otherwise)", async () => {
		const moaSlot: Slot = { provider: "moa", model: "default" };
		const call: CallSlot = async (slot) => {
			if (slot.provider.toLowerCase() === "moa") throw new Error("[skipped]");
			return "agg-answer";
		};
		const out = await aggregate({
			refs: [{ ok: false, slot: moaSlot, error: "[skipped]" }],
			mode: "session",
			instruction: "Q",
			call,
			aggregator: AGG,
		});
		expect(out).toBe("agg-answer");
	});
});
