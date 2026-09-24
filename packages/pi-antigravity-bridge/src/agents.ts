// agy custom-agent roster (stream-json engine only).
//
// `agy agent` (alias `agents`) lists the user's custom agents one per line.
// Live-verified against agy 1.2.10: bare names, no banner and no columns
// when agents exist; help text on bad flags; empty output when none. The
// parser still tolerates a name-plus-description column layout and banner
// lines so a future agy that annotates the listing keeps parsing.
//
// A picked name rides the turn request as `--agent` (same flag our web
// tools already pass for their throwaway agents). ACP has no agent slot in
// the protocol (RC01), so selection is refused at the command level there.

import { spawnAgyRaw } from "./models.js";

/** Agent names are agy agent-dir names: filesystem-safe tokens. */
export const AGENT_NAME_MAX = 128;
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Parse raw `agy agent` output into agent names. Tolerant: skips empty and
 *  banner/help lines, takes the first whitespace-separated token per line
 *  (a future description column survives), rejects names that are not
 *  filesystem-safe tokens, dedupes preserving order. */
export function parseAgyAgentsRaw(text: string): string[] {
	const seen = new Set<string>();
	const agents: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Help output and older banner formats are noise, not agent names
		// (checked on the whole line: "List available agents" has no single
		// banner token).
		if (/^(usage:|flags:|-h\b|list available|available agents)/i.test(trimmed)) continue;
		const token = trimmed.split(/\s+/)[0] ?? "";
		if (!AGENT_NAME_RE.test(token) || seen.has(token)) continue;
		seen.add(token);
		agents.push(token);
	}
	return agents;
}

/** True when `name` is a valid agent-dir token (what `--agent` accepts). */
export function isValidAgyAgentName(name: string): boolean {
	return AGENT_NAME_RE.test(name);
}

/** Normalize a configured agent value: trim, cap, strip control characters;
 *  empty result means "no agent configured". Kept permissive beyond the
 *  token regex so a user typo reaches agy's own validation (a visible
 *  turn error) instead of silently reverting to the default agent. */
export function normalizeAgyAgentName(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const cleaned = value
		.trim()
		.replace(/[\x00-\x1f\x7f]/g, "")
		.slice(0, AGENT_NAME_MAX);
	return cleaned === "" ? undefined : cleaned;
}

/** List the custom agents `agy agent` reports. "" stdout (missing binary,
 *  failure, cap) parses to [], so callers can treat "no agents" and "could
 *  not ask" the same way the command layer renders it. */
export async function listAgyAgents(binary: string = "agy"): Promise<string[]> {
	return parseAgyAgentsRaw(await spawnAgyRaw(binary, ["agent"]));
}
