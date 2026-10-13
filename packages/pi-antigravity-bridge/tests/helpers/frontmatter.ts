// Shared test helper: parse the YAML frontmatter block of a generated
// agent.md with a real YAML parser. agy silently drops an agent whose
// frontmatter does not parse (issue #5: the turn then dies on "unknown
// agent"), so every agent.md generator is pinned through this, not regexes.

import { parse } from "yaml";

export function parseAgentFrontmatter(md: string): Record<string, unknown> {
	const m = /^---\n([\s\S]*?)\n---/.exec(md);
	if (!m) throw new Error("no frontmatter block found");
	return parse(m[1]) as Record<string, unknown>;
}
