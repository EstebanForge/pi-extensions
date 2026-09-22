/**
 * Config load / normalize / validate / save for pi-mixture-of-agents.
 *
 * Two config locations are merged (project overrides user):
 *   - user:    ~/.pi/agent/moa.json
 *   - project: <cwd>/.pi/moa.json   (CONFIG_DIR_NAME aware)
 *
 * Validation enforces the recursion guard: any slot with provider === "moa"
 * is rejected (the reference blocks recursive MoA trees, moa_loop.py:142). This is
 * the first line of defense; the runtime also skips such slots with a note.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	type MoaConfig,
	type NormalizedConfig,
	type NormalizedPreset,
	type Preset,
	type Slot,
	ConfigError,
	RecursionError,
} from "./types";

/** Default per-preset field values (mirrors the reference's moa_config.py). */
export const DEFAULTS = {
	reference_temperature: 0.6,
	aggregator_temperature: 0.4,
	max_tokens: 4096,
	enabled: true,
} as const;

/**
 * Placeholder default preset. Slots intentionally reference models the user
 * must replace with ones present in their own Pi catalog; we never ship
 * fabricated model IDs. `default_preset` resolves to "default" but the
 * preset itself is `enabled: false` until configured, so selecting moa/default
 * out of the box just runs the (also-placeholder) aggregator alone.
 */
export function defaultConfig(): MoaConfig {
	return {
		default_preset: "default",
		presets: {
			default: {
				reference_models: [
					{ provider: "<provider>", model: "<model>" },
				],
				aggregator: { provider: "<provider>", model: "<model>" },
				enabled: false,
			},
		},
	};
}

/** Reject any slot whose provider is the virtual moa provider itself. */
export function assertNotRecursive(slot: Slot): void {
	if (slot.provider.toLowerCase() === "moa") {
		throw new RecursionError(slot);
	}
}

/** Validate a slot has both fields and is not recursive. */
function validateSlot(slot: unknown, where: string): Slot {
	if (!slot || typeof slot !== "object") {
		throw new ConfigError(`${where}: expected an object with provider and model`);
	}
	const s = slot as Partial<Slot>;
	if (!s.provider || typeof s.provider !== "string") {
		throw new ConfigError(`${where}: missing or invalid "provider"`);
	}
	if (!s.model || typeof s.model !== "string") {
		throw new ConfigError(`${where}: missing or invalid "model"`);
	}
	assertNotRecursive(s as Slot);
	return { provider: s.provider, model: s.model };
}

/** Apply defaults to a raw preset and validate every slot. */
export function normalizePreset(name: string, raw: Preset): NormalizedPreset {
	if (!raw || typeof raw !== "object") {
		throw new ConfigError(`preset "${name}": expected an object`);
	}
	if (!raw.aggregator) {
		throw new ConfigError(`preset "${name}": missing "aggregator"`);
	}
	const aggregator = validateSlot(raw.aggregator, `preset "${name}".aggregator`);

	const reference_models = Array.isArray(raw.reference_models)
		? raw.reference_models.map((s, i) => validateSlot(s, `preset "${name}".reference_models[${i}]`))
		: [];

	return {
		reference_models,
		aggregator,
		reference_temperature: raw.reference_temperature ?? DEFAULTS.reference_temperature,
		aggregator_temperature: raw.aggregator_temperature ?? DEFAULTS.aggregator_temperature,
		max_tokens: raw.max_tokens ?? DEFAULTS.max_tokens,
		enabled: raw.enabled ?? DEFAULTS.enabled,
	};
}

/**
 * Normalize a raw config into a fully-resolved shape.
 *
 * Backward-compat: a legacy flat shape like `{ reference_models, aggregator }`
 * (no `presets` key) is folded into a single "default" preset.
 */
export function normalizeConfig(raw: MoaConfig | null | undefined): NormalizedConfig {
	if (!raw || typeof raw !== "object") {
		return { default_preset: "default", presets: {} };
	}

	const flat = raw as Record<string, unknown>;
	let presets: Record<string, Preset>;
	if (flat.presets && typeof flat.presets === "object") {
		presets = raw.presets as Record<string, Preset>;
	} else if (flat.aggregator || flat.reference_models) {
		// Legacy flat shape: treat the whole object as one preset.
		presets = { default: raw as unknown as Preset };
	} else {
		presets = {};
	}

	const normalized: Record<string, NormalizedPreset> = {};
	for (const [name, p] of Object.entries(presets)) {
		normalized[name] = normalizePreset(name, p);
	}

	const default_preset = raw.default_preset && normalized[raw.default_preset]
		? raw.default_preset
		: Object.keys(normalized)[0] ?? "default";

	return { default_preset, presets: normalized };
}

/** Resolve a preset by name, falling back to the config default. */
export function resolvePreset(config: NormalizedConfig, name?: string): NormalizedPreset | undefined {
	const key = (name && config.presets[name]) ? name : config.default_preset;
	return config.presets[key];
}

/** Format a normalized config as a human-readable preset listing. */
export function formatPresetList(config: NormalizedConfig): string {
	const names = Object.keys(config.presets);
	if (names.length === 0) {
		return "No MoA presets configured. Run /moa to create one (TUI), or edit ~/.pi/agent/moa.json directly.";
	}
	const lines = names.map((name) => {
		const p = config.presets[name];
		const marker = name === config.default_preset ? " (default)" : "";
		const flag = p.enabled ? "" : " [disabled]";
		const refs = p.reference_models.length === 0
			? "(no refs; aggregator alone)"
			: p.reference_models.map((s) => `${s.provider}/${s.model}`).join(", ");
		return `- ${name}${marker}${flag}\n  refs: ${refs}\n  agg:  ${p.aggregator.provider}/${p.aggregator.model}`;
	});
	return `MoA presets:\n${lines.join("\n")}`;
}

/** Set or replace a preset on a raw config object (returns a new object). */
export function upsertPreset(raw: MoaConfig, name: string, preset: Preset): MoaConfig {
	const presets = { ...(raw.presets ?? {}) };
	presets[name] = preset;
	const defaultPreset = raw.default_preset ?? name;
	return { default_preset: defaultPreset, presets };
}

/** Remove a preset from a raw config object (returns a new object). */
export function removePreset(raw: MoaConfig, name: string): MoaConfig {
	const presets = { ...(raw.presets ?? {}) };
	delete presets[name];
	let defaultPreset = raw.default_preset;
	// If we removed the default, fall back to the first remaining or "default".
	if (defaultPreset === name || !presets[defaultPreset ?? ""]) {
		defaultPreset = Object.keys(presets)[0] ?? "default";
	}
	return { default_preset: defaultPreset, presets };
}

/**
 * Rename a preset key. Preserves insertion order and keeps the default pointer
 * valid. Returns undefined if the source doesn't exist or the target name is
 * already taken (caller surfaces the collision to the user).
 */
export function renamePreset(raw: MoaConfig, from: string, to: string): MoaConfig | undefined {
	if (from === to) return raw;
	const presets = raw.presets ?? {};
	const preset = presets[from];
	if (!preset) return undefined;
	if (presets[to]) return undefined; // target name already in use

	// Rebuild preserving insertion order: same keys, but `from` becomes `to`.
	const renamed: Record<string, Preset> = {};
	for (const [key, value] of Object.entries(presets)) {
		renamed[key === from ? to : key] = value;
	}
	const defaultPreset = raw.default_preset === from ? to : raw.default_preset;
	return { default_preset: defaultPreset, presets: renamed };
}

async function readJson(file: string): Promise<MoaConfig | null> {
	try {
		const txt = await readFile(file, "utf8");
		return JSON.parse(txt) as MoaConfig;
	} catch {
		return null;
	}
}

/**
 * Load and merge user + project config (project wins).
 *
 * @param home    user home dir (defaults to os.homedir()).
 * @param cwd     project dir (defaults to process.cwd()).
 */
/** Absolute path to the user-scoped moa.json (~/.pi/agent/moa.json). */
export function userConfigPath(home?: string): string {
	return path.join(home ?? findHome(), ".pi", "agent", "moa.json");
}

export async function loadConfig(home?: string, cwd?: string): Promise<NormalizedConfig> {
	const userFile = userConfigPath(home);
	const projectFile = path.join(cwd ?? process.cwd(), CONFIG_DIR_NAME, "moa.json");

	const [userRaw, projectRaw] = await Promise.all([readJson(userFile), readJson(projectFile)]);

	// Shallow-merge at the preset level: project presets override user presets
	// by name; user default_preset is kept unless project sets one.
	const merged: MoaConfig = {
		default_preset: projectRaw?.default_preset ?? userRaw?.default_preset,
		presets: { ...(userRaw?.presets ?? {}), ...(projectRaw?.presets ?? {}) },
	};

	return normalizeConfig(merged);
}

/** Save a raw config object to the user file, creating the dir if needed. */
export async function saveConfig(cfg: MoaConfig, home?: string): Promise<void> {
	const file = userConfigPath(home);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function findHome(): string {
	// Lazy import to avoid touching node:os at module load on platforms that
	// resolve types eagerly.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const os = require("node:os") as typeof import("node:os");
	return os.homedir();
}
