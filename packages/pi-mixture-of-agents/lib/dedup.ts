/**
 * Per-turn reference dedup.
 *
 * Mirrors moa_loop.py:347-369. The agent loop calls the MoA
 * facade once per tool-loop iteration within a single user turn. The advisory
 * view (trimmed transcript) does not change across those iterations, so
 * re-running the reference fan-out each time would multiply API cost for no
 * benefit. We cache reference outputs keyed by a signature of the advisory
 * view + preset + reference slot labels, and reuse them on a hit.
 *
 * Cache is in-memory and turn-scoped: cleared on `model_select` (new user
 * turn boundary) and never persisted.
 */
import { createHash } from "node:crypto";
import type { AdvisoryMessage } from "./transcript";
import type { ReferenceResult, Slot } from "./types";

/**
 * Build the cache key for an advisory view under a given preset/slot set.
 *
 * Matches the reference shape: `(preset_name, sha256(advisory), slot_labels)`.
 * The advisory signature is SHA-256 over `\u0000`-joined `role:content` pairs,
 * matching moa_loop.py:351-355.
 */
export function signature(
	messages: readonly AdvisoryMessage[],
	presetName: string,
	slots: readonly Slot[],
): string {
	const joined = messages
		.map((m) => `${m.role}:${m.content.map((c) => c.text).join("\n")}`)
		.join("\u0000");
	const sig = createHash("sha256").update(joined, "utf8").digest("hex");
	const slotLabels = slots.map((s) => `${s.provider}/${s.model}`).join(",");
	return `${presetName}:${sig}:${slotLabels}`;
}

/** Per-extension-instance turn cache. Stores the last fan-out outputs. */
export class TurnCache {
	private key: string | null = null;
	private outputs: ReferenceResult[] = [];

	/** Returns cached outputs when the key matches and outputs are non-empty. */
	get(key: string): ReferenceResult[] | null {
		if (key === this.key && this.outputs.length > 0) {
			// Shallow copy so callers cannot mutate our cache.
			return this.outputs.map((r) => ({ ...r }));
		}
		return null;
	}

	/** Record outputs for the current key. */
	set(key: string, outputs: readonly ReferenceResult[]): void {
		this.key = key;
		this.outputs = outputs.map((r) => ({ ...r }));
	}

	/** Clear on turn boundary (model_select, session reset). */
	clear(): void {
		this.key = null;
		this.outputs = [];
	}
}
