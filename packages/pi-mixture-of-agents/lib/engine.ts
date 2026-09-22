/**
 * Pure MoA engine: reference fan-out + aggregation.
 *
 * No Pi imports here. The caller injects a `CallSlot` (see slots.ts) so this
 * module is unit-testable with a mock and stays free of network/model-registry
 * Mirrors the MoA `moa_loop.py` orchestration:
 *
 *   - run references in parallel, preserving slot order
 *   - per-reference failures are tolerated (folded into results, do not abort)
 *   - abort-aware: signal threads into every call
 *   - empty references (enabled:false or all failed) -> aggregator still runs
 *     and guidance is omitted
 */
import { aggregatorPrompt, hasUsableGuidance, wrapGuidance } from "./prompts";
import { renderAdvisoryInstruction } from "./transcript";
import type { AdvisoryMessage } from "./transcript";
import type { CallSlot, NormalizedPreset, ReferenceResult, Slot } from "./types";

/** Optional progress callback: (slotIndex, total, phase, slotLabel?). */
export type OnProgress = (
	index: number,
	total: number,
	phase: "ref-start" | "ref-done" | "ref-failed" | "aggregating",
	slotLabel?: string,
) => void;

/** Inputs to the reference fan-out. */
export interface RunReferencesArgs {
	slots: readonly Slot[];
	/** Each reference receives the user-turn instruction (the trimmed advisory). */
	instruction: string;
	call: CallSlot;
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	onProgress?: OnProgress;
}

/**
 * Fan out reference calls in parallel, preserving slot order.
 *
 * Per-slot try/catch: a failure becomes `{ ok:false, error }` and does NOT
 * abort siblings (mirrors the MoA reference's failure tolerance). Abort propagates: when
 * `signal` aborts, pending/rejected calls surface as failed results.
 */
export async function runReferences(args: RunReferencesArgs): Promise<ReferenceResult[]> {
	const { slots, instruction, call, temperature, maxTokens, signal, onProgress } = args;
	const total = slots.length;

	const results = await Promise.all(
		slots.map(async (slot, index): Promise<ReferenceResult> => {
			const label = `${slot.provider}/${slot.model}`;
			onProgress?.(index, total, "ref-start", label);
			try {
				const text = await call(slot, instruction, { temperature, maxTokens, signal });
				onProgress?.(index, total, "ref-done", label);
				return { ok: true, slot, text };
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				onProgress?.(index, total, "ref-failed", label);
				return { ok: false, slot, error };
			}
		}),
	);

	return results;
}

/** Inputs to the aggregator call. */
export interface AggregateArgs {
	refs: readonly ReferenceResult[];
	/** One-shot (advisory guidance) vs session (aggregator is acting model). */
	mode: "oneshot" | "session";
	/** The user turn text / instruction the aggregator should respond to. */
	instruction: string;
	call: CallSlot;
	aggregator: Slot;
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
}

/**
 * Call the aggregator with the synthesized prompt.
 *
 * Returns the raw text the aggregator produced. The caller (facade or
 * one-shot command) decides how to inject / emit it. When there are no usable
 * references, the guidance block is omitted and the aggregator is called with
 * just the instruction (mirrors the disabled / empty-refs path).
 */
export async function aggregate(args: AggregateArgs): Promise<string> {
	const { refs, mode, instruction, call, aggregator, temperature, maxTokens, signal } = args;

	// No usable refs -> no guidance block; aggregator answers the turn alone.
	if (!hasUsableGuidance(refs)) {
		return call(aggregator, instruction, { temperature, maxTokens, signal });
	}

	const prompt = aggregatorPrompt(refs, mode);
	// Prepend guidance ahead of the instruction so the aggregator sees both.
	const full = mode === "oneshot"
		? `${prompt}\n\n---\n\nUser request (do NOT answer directly; produce guidance for the main agent):\n${instruction}`
		: `${prompt}\n\n---\n\nRespond to the user request below (you are the acting model):\n${instruction}`;

	const raw = await call(aggregator, full, { temperature, maxTokens, signal });
	// In one-shot mode the aggregator output IS the guidance; wrap it.
	// In session mode the aggregator output IS the answer; return as-is.
	return mode === "oneshot" ? wrapGuidance(raw) : raw;
}

/**
 * Convenience: run refs then aggregate for a preset, honoring `enabled`.
 *
 * - `enabled:false` -> skip refs entirely (empty list), aggregator runs alone.
 * - Otherwise fan out the preset's reference_models, then aggregate.
 *
 * `presetName` + slots are passed back via the progress callback for status UI.
 */
export async function runPresetTurn(args: {
	preset: NormalizedPreset;
	advisory: readonly AdvisoryMessage[];
	call: CallSlot;
	mode: "oneshot" | "session";
	signal?: AbortSignal;
	onProgress?: OnProgress;
}): Promise<{ refs: ReferenceResult[]; guidance: string }> {
	const { preset, advisory, call, mode, signal, onProgress } = args;

	// The user-turn instruction refs see: a flattened, role-labeled view of
	// the advisory transcript. Deterministic -> pairs with dedup.signature.
	const instruction = renderAdvisoryInstruction(advisory);

	const refs = preset.enabled
		? await runReferences({
			slots: preset.reference_models,
			instruction,
			call,
			temperature: preset.reference_temperature,
			maxTokens: preset.max_tokens,
			signal,
			onProgress,
		})
		: [];

	onProgress?.(0, 1, "aggregating", `${preset.aggregator.provider}/${preset.aggregator.model}`);
	const guidance = await aggregate({
		refs,
		mode,
		instruction,
		call,
		aggregator: preset.aggregator,
		temperature: preset.aggregator_temperature,
		maxTokens: preset.max_tokens,
		signal,
	});

	return { refs, guidance };
}
