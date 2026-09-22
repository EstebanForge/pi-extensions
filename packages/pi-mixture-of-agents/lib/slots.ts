/**
 * Slot resolution + model calls for pi-mixture-of-agents.
 *
 * A slot is a {provider, model} pair. `callSlot` resolves it through Pi's
 * model registry (credentials + headers) and calls pi-ai's `complete()`.
 *
 * The engine takes a `CallSlot` as a dependency so its core stays pure and
 * unit-testable without touching the network. This module is the only file
 * that imports pi-ai/compat and the model registry.
 */
import { complete } from "@earendil-works/pi-ai/compat";
import type { CallSlot, Slot, SlotContext } from "./types";

/**
 * Resolve a slot's {provider, model} to a live model handle via Pi's
 * ModelRegistry, NOT pi-ai's static catalog. The registry is the single
 * runtime source of truth: built-in providers + dynamically registered ones
 * (custom bridges like `claude-bridge`, the virtual `moa` provider itself)
 * that pi-ai's build-time getModel cannot see. A miss surfaces as a thrown
 * error so the engine can fold it into the per-slot failure result.
 */
function resolveModel(ctx: SlotContext, slot: Slot, where = "model"): unknown {
	const model = ctx.modelRegistry.find(slot.provider, slot.model);
	if (!model) {
		throw new Error(`${where} ${slot.provider}/${slot.model} not in catalog`);
	}
	return model;
}

/** Message shape accepted by pi-ai complete(): role + content array. */
type PiMessage = { role: string; content: unknown };

/**
 * Build a `CallSlot` bound to a Pi ExtensionContext.
 *
 * Returns the model's text response. Throws on any failure (the engine
 * catches per-slot and folds the error into the reference results, mirroring
 * the reference's failure tolerance).
 *
 * Recursion guard (runtime safety net, mirrors moa_loop.py:142): a slot whose
 * provider is the virtual `moa` provider is skipped with a labelled note
 * instead of being called.
 */
export function makeCallSlot(ctx: SlotContext): CallSlot {
	return async (slot, instruction, opts) => {
		if (slot.provider.toLowerCase() === "moa") {
			throw new Error("[skipped: MoA presets cannot recursively reference MoA]");
		}

		const model = resolveModel(ctx, slot) as Parameters<typeof complete>[0];

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok === false) {
			throw new Error(auth.error);
		}

		const resp = await complete(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				temperature: opts.temperature,
				maxTokens: opts.maxTokens,
				signal: opts.signal,
			},
		);

		const text = resp.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!text) throw new Error("empty response");
		return text;
	};
}

/**
 * Call the aggregator with a full message list (including the tail-injected
 * guidance) and a tool schema. Returns the raw AssistantMessage so the
 * facade can re-emit its content (text + tool calls) through the stream.
 */
export async function callAggregator(
	slot: Slot,
	ctx: SlotContext,
	args: {
		messages: PiMessage[];
		tools?: unknown;
		systemPrompt?: string;
		temperature?: number;
		maxTokens?: number;
		signal?: AbortSignal;
	},
) {
	if (slot.provider.toLowerCase() === "moa") {
		throw new Error("[skipped: MoA aggregator cannot be a MoA preset]");
	}
	const model = resolveModel(ctx, slot, "aggregator model") as Parameters<typeof complete>[0];

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) throw new Error(auth.error);

	// TYPE-ESCAPE HATCH: `complete()` takes Pi's public Context shape, which
	// normalizeContext() folds into TranscriptContext. `args.messages` must not
	// carry an initial system message when `args.systemPrompt` is supplied.
	// pi-ai's `complete()` is generic over KnownProvider/Message/Tool, which
	// collapses to `never` for runtime string providers. `as never` bypasses
	// the generic here on purpose — the structures are structurally compatible
	// at runtime, and a future pi-ai field rename would surface as a runtime
	// shape mismatch, not a compile error. This is a known, accepted trade-off.
	// Do not widen without verifying the live pi-ai Context shape.
	return complete(
		model,
		{
			messages: args.messages as never,
			tools: args.tools as never,
			systemPrompt: args.systemPrompt,
		} as never,
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			temperature: args.temperature,
			maxTokens: args.maxTokens,
			signal: args.signal,
		},
	);
}
