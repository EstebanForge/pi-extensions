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
// no inheritMcp override): provider sessions need the bridge MCP config for
// G9 round-trips. Two deliberate exceptions. The tools list: omitting tools
// reads as "read-only defaults" upstream, not "all tools", which stripped
// write/edit/command from carrier sessions (issue #13; agy appends the
// resource/MCP tools itself, so G9 round-trips ride call_mcp_tool
// regardless). The subagent keys: agent-file presence already suppresses
// agy's native subagent tools (probed 2026-10-20, issue #7), and declaring
// it makes the suppression explicit instead of relying on the accident
// (whether the keys themselves mask, apart from presence, is unattributed).
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

/** Opening sentence of pi's default system prompt, and the wording the carrier
 *  ships instead. */
export const PI_OPENING = "running inside pi, a coding agent harness";
const PI_OPENING_REWORDED = "running inside the pi coding agent harness";
/** Start of the docs-index line of pi's default system prompt. */
export const PI_DOCS_INDEX_PREFIX = "- When asked about: extensions (docs/";

/** Scrubbed carrier text plus which scrubs applied (the `sysprompt-scrub`
 *  staging event's payload). */
export interface CarrierScrub {
	text: string;
	opening: boolean;
	docsLine: boolean;
}

/** Two lines of pi's default system prompt make the Antigravity backend answer
 *  `RESOURCE_EXHAUSTED (code 429)` to every request of a carrier session, each
 *  on its own and at 0% quota use (probed 2026-11-27, agy 1.5.18, with
 *  gemini-4-hydrogen, gemini-4-neon and claude-sonnet-5-5): the opening
 *  sentence and the docs-index line. A carrier holding either one never
 *  completes a turn. Reword the first (same meaning) and drop the second (it
 *  only maps pi's own docs for questions about the harness). The match is
 *  exact on purpose: a custom system prompt passes through untouched.
 *  Point fix (issue #30): the backend rule behind the two lines is unknown
 *  (the upstream match is not exact text), so a future reword of pi's prompt
 *  can silently re-break staging; the provider's `sysprompt-scrub` staging
 *  event exists to tell "scrub ran, still 429" from "scrub no longer
 *  matches" (needs AGY_DEBUG=1: the daily log is error-only by default). */
export function carrierScrubInfo(body: string): CarrierScrub {
	const lines = body.split("\n");
	const kept = lines.filter((line) => !line.startsWith(PI_DOCS_INDEX_PREFIX));
	const keptText = kept.join("\n");
	return {
		text: keptText.replaceAll(PI_OPENING, PI_OPENING_REWORDED),
		// On the kept text: the phrase sitting only inside a dropped docs line
		// must not report a reword that never happened.
		opening: keptText.includes(PI_OPENING),
		docsLine: kept.length !== lines.length,
	};
}

/** carrierScrubInfo's text, for callers that do not log the flags. */
export function carrierSafeBody(body: string): string {
	return carrierScrubInfo(body).text;
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
		"tools:",
		// Block style, not flow: the web delegates (web-tools.ts) prove agy
		// parses this shape; flow style is only proven in the issue report.
		"  - read_file",
		"  - edit_file",
		"  - write_file",
		"  - run_command",
		"  - manage_task",
		"  - search_web",
		"---",
		"",
		carrierSafeBody(body),
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
