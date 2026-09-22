/**
 * Aggregator prompts for pi-mixture-of-agents.
 *
 * The MoA technique uses two meaningfully different aggregator prompt
 * strategies:
 *
 *  1. One-shot — the aggregator synthesizes refs into ADVISORY guidance for
 *     the main agent. It must NOT answer the user directly. The main agent
 *     loop then consumes that guidance and produces the real answer.
 *
 *  2. Session — the aggregator IS the acting model. It answers the user or
 *     calls tools directly, with the reference context appended as background.
 *
 * The block wrapper `[Mixture of Agents reference context]` is the same in
 * both; only the surrounding instruction differs.
 */
import type { ReferenceResult } from "./types";

/** Header used on the injected guidance block (both modes). */
export const GUIDANCE_HEADER = "[Mixture of Agents reference context]";

/** One-shot aggregator instruction: synthesize advisory guidance (no direct answer). */
const ONE_SHOT_INSTRUCTION = [
	"You are the aggregator in a Mixture of Agents process.",
	"Synthesize the reference responses below into concise, actionable guidance for the main agent.",
	"Focus on next steps, tool-use strategy, risks, and any disagreements.",
	"Do not answer the user directly unless that is all that is needed.",
].join(" ");

/** Session-mode aggregator instruction: it IS the acting model. */
export const SESSION_INSTRUCTION = [
	"You are the acting model in a Mixture of Agents process.",
	"Reference model analyses are provided below as background context.",
	"Answer the user or call tools directly as needed; do not just summarize the references.",
].join(" ");

/** Render reference outputs (with failures) into a labelled block. */
function renderRefs(refs: readonly ReferenceResult[]): string {
	const parts = refs.map((r, i) => {
		const label = `[reference ${i + 1}]`;
		return r.ok ? `${label}\n${r.text}` : `${label}\n[reference failed: ${r.error}]`;
	});
	return parts.join("\n\n");
}

/** Build the full aggregator system/user instruction for the given mode. */
export function aggregatorPrompt(
	refs: readonly ReferenceResult[],
	mode: "oneshot" | "session",
): string {
	const instruction = mode === "oneshot" ? ONE_SHOT_INSTRUCTION : SESSION_INSTRUCTION;
	const body = renderRefs(refs);
	return `${instruction}\n\n${body}`;
}

/**
 * Wrap finalized guidance text with the canonical header.
 * Returns "" when there is nothing to inject (no refs / all failed and the
 * mode omits guidance in that case).
 */
export function wrapGuidance(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	return `${GUIDANCE_HEADER}\n${trimmed}`;
}

/** True when guidance should be appended at all (refs present and non-empty). */
export function hasUsableGuidance(refs: readonly ReferenceResult[]): boolean {
	return refs.some((r) => r.ok && r.text.trim().length > 0);
}
