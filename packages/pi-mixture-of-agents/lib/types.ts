/**
 * Config types for pi-mixture-of-agents.
 *
 * Mirrors the reference `moa` config shape adapted to JSON. A preset is an explicit list of
 * reference slots plus one aggregator slot; slots are {provider, model} pairs
 * so presets can mix providers and use multiple models from the same provider.
 */

/** A single model endpoint: provider name + model id, both as Pi knows them. */
export interface Slot {
	provider: string;
	model: string;
}

/**
 * A named MoA recipe.
 *
 * - `reference_models` fan out in parallel over a trimmed transcript.
 * - `aggregator` synthesizes their outputs and is the acting model.
 * - `enabled: false` clears the references and lets the aggregator run alone.
 */
export interface Preset {
	reference_models: Slot[];
	aggregator: Slot;
	/** Sampling temperature for reference calls. Default 0.6. */
	reference_temperature?: number;
	/** Sampling temperature for the aggregator call. Default 0.4. */
	aggregator_temperature?: number;
	/** Max output tokens for both reference and aggregator calls. Default 4096. */
	max_tokens?: number;
	/** Per-preset off switch: when false, references are skipped. Default true. */
	enabled?: boolean;
}

/** Top-level config file shape (~/.pi/agent/moa.json or .pi/moa.json). */
export interface MoaConfig {
	default_preset?: string;
	presets?: Record<string, Preset>;
}

/** A Preset with all optional fields filled in. */
export interface NormalizedPreset extends Preset {
	reference_models: Slot[];
	aggregator: Slot;
	reference_temperature: number;
	aggregator_temperature: number;
	max_tokens: number;
	enabled: boolean;
}

/** Result of normalizing the whole config: resolved defaults, guaranteed shape. */
export interface NormalizedConfig {
	default_preset: string;
	presets: Record<string, NormalizedPreset>;
}

/** Outcome of a single reference-model call. */
export type ReferenceResult =
	| { ok: true; slot: Slot; text: string }
	| { ok: false; slot: Slot; error: string };

/**
 * Calls a single model slot with a message list and returns its text.
 * Injected into the engine so the core stays pure and testable.
 */
export type CallSlot = (
	slot: Slot,
	instruction: string,
	opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
) => Promise<string>;

/**
 * Minimal subset of Pi's ExtensionContext used for slot resolution.
 *
 * `find` resolves a {provider, model} to a live model handle through Pi's
 * ModelRegistry — the runtime source of truth that holds built-in providers
 * AND dynamically registered ones (e.g. `claude-bridge`, the virtual `moa`
 * provider) that pi-ai's static build-time catalog cannot see. The handle is
 * opaque here so this module stays free of pi-ai type imports.
 */
export interface SlotContext {
	modelRegistry: {
		find(provider: string, modelId: string): unknown;
		getApiKeyAndHeaders(model: unknown): Promise<
			| { ok: true; apiKey?: string; headers?: Record<string, string | null>; env?: Record<string, string> }
			| { ok: false; error: string }
		>;
	};
}

/** Error thrown when a preset references itself recursively. */
export class RecursionError extends Error {
	constructor(slot: Slot) {
		super(`MoA presets cannot reference the "moa" provider (recursion): ${slot.provider}/${slot.model}`);
		this.name = "RecursionError";
	}
}

/** Error thrown when a preset is structurally invalid (missing fields, etc). */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}
