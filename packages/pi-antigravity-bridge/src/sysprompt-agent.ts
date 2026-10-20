// G10 delivery for the stream-json engine: staged system-prompt agent.
//
// agy's stream-json prompt path silently drops any turn past a ~25KB input
// cap (probed 2026-09-30, issue #2: status SUCCESS, empty response, zero
// usage, no error — and the dropped turn leaves the conversation permanently
// unresponsive to later input). The pi system prompt block used to ride the
// first prompt of every fresh conversation and routinely crossed that cap,
// killing the whole session. It now stages as an agy agent file discovered
// under ~/.gemini/config/agents and passed via --agent: the CLI reads agent
// files from disk, off the prompt line, so the cap never applies.
//
// Frontmatter keeps agy's DEFAULTS on purpose (no excludeDefaultComponents,
// no tools list, no inheritMcp override): provider sessions need the normal
// toolset and the bridge MCP config for G9 round-trips. The subagent keys are
// the one deliberate exception: agent-file presence already suppresses agy's
// native subagent tools (probed 2026-10-20, issue #7), and declaring it makes
// the suppression explicit instead of relying on the accident (whether the
// keys themselves mask, apart from presence, is unattributed).
// Contrast the ask-tool reviewer agent, which strips everything for
// sandboxing.
//
// Lifecycle: one agent dir per DISTINCT body (content-addressed by sha256);
// two conversations with different system prompts in one process stage two
// dirs and never overwrite each other, so a driver respawn mid-conversation
// always reloads that conversation's own instructions. Same body -> same dir
// (write-once; identical bytes are never rewritten). The name stays stable
// across the turns of a conversation so the driver's profile comparison
// never recycles on "agent" drift. The .pid marker lets sweepStaleWebAgents
// prune orphans (same doctrine as the web delegates and the ask-tool
// reviewer).

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepStaleWebAgents } from "./web-tools.js";

export const SYS_AGENT_PREFIX = "pi-bridge-sys-";

/** AGY_AGENTS_ROOT override for tests and sandboxes (same contract as the
 *  ask-tool reviewer root). */
export function syspromptAgentsRoot(): string {
	return process.env.AGY_AGENTS_ROOT ?? path.join(os.homedir(), ".gemini", "config", "agents");
}

/** agent.md for the carrier. The body is the pi system prompt composed by the
 *  provider (preamble + transcript system prompt + tool-priority note). */
export function syspromptAgentMd(name: string, body: string): string {
	return [
		"---",
		`name: ${name}`,
		// Quoted value: it contains ': ', invalid inside an unquoted plain
		// scalar — agy then silently drops the agent (issue #5).
		"description: \"Pi bridge system-prompt carrier: pi operating instructions plus project AGENTS.md context\"",
		"mainAgent: true",
		"model: inherit",
		"subagent: false",
		"agents: []",
		"---",
		"",
		body,
		"",
	].join("\n");
}

interface Staged {
	root: string;
	name: string;
	dir: string;
}

/** Content-addressed staging cache: body sha256 -> staged dir. Two
 *  conversations with different system prompts in one process must never
 *  share a carrier file (a rewrite would leak one conversation's instructions
 *  into the other's respawned agy process). */
const stagedByHash = new Map<string, Staged>();

function bodyHash(body: string): string {
	return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

/** Stage the carrier agent with `body` as its instructions. Content-addressed:
 *  the same body reuses its dir (no rewrite), a new body gets a fresh dir.
 *  Returns the agent name for --agent, or null when staging failed — the
 *  caller then falls back to the legacy inline prompt block, where the
 *  silent-drop guard keeps the cap risk visible. */
export function stageSyspromptAgent(
	body: string,
	opts: { agentsRoot?: string } = {},
): string | null {
	try {
		const root = opts.agentsRoot ?? syspromptAgentsRoot();
		const hash = bodyHash(body);
		const cached = stagedByHash.get(hash);
		if (cached && cached.root === root) return cached.name;
		sweepStaleWebAgents(root, Date.now(), SYS_AGENT_PREFIX);
		fs.mkdirSync(root, { recursive: true });
		// Nonce: two pi processes staging the same body must not fight over one
		// dir; the pid plus nonce keeps every staging attempt self-contained.
		const name = `${SYS_AGENT_PREFIX}${hash}-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
		const dir = path.join(root, name);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(dir, ".pid"), `${process.pid}\n`, { mode: 0o600 });
		fs.writeFileSync(path.join(dir, "agent.md"), syspromptAgentMd(name, body), {
			mode: 0o600,
		});
		const entry: Staged = { root, name, dir };
		stagedByHash.set(hash, entry);
		return entry.name;
	} catch {
		return null;
	}
}

/** Test hook: forget the staging cache without touching the filesystem. */
export function resetSyspromptAgentForTests(): void {
	stagedByHash.clear();
}
