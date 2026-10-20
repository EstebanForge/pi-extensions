// Unit tests for src/sysprompt-agent.ts (G10 staged carrier agent).
// AGY_AGENTS_ROOT / opts.agentsRoot keeps every write inside a tmpdir.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
	resetSyspromptAgentForTests,
	stageSyspromptAgent,
	syspromptAgentMd,
} from "../src/sysprompt-agent.js";
import { parseAgentFrontmatter } from "./helpers/frontmatter.js";

function tmpAgentsRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-sys-agents-"));
}

afterEach(() => {
	resetSyspromptAgentForTests();
});

test("agent.md keeps agy defaults except the declared subagent masking", () => {
	const md = syspromptAgentMd("pi-bridge-sys-x", "BODY");
	assert.match(md, /^---\nname: pi-bridge-sys-x\n/);
	// The carrier must NOT strip agy's defaults: provider sessions need the
	// normal toolset and the bridge MCP config for G9 round-trips.
	assert.equal(md.includes("excludeDefaultComponents"), false);
	assert.equal(md.includes("inheritMcp"), false);
	assert.equal(md.includes("tools:"), false);
	assert.ok(md.endsWith("BODY\n"));
});

test("frontmatter parses as YAML (agy drops unparsable agents, issue #5)", () => {
	// The description carries a second ': ': as an unquoted plain scalar that
	// is invalid YAML, agy silently skips the agent at discovery and every
	// --agent turn fails with "unknown agent". Pin the quoted form.
	const fm = parseAgentFrontmatter(syspromptAgentMd("pi-bridge-sys-x", "BODY"));
	assert.equal(fm.name, "pi-bridge-sys-x");
	assert.equal(
		fm.description,
		"Pi bridge system-prompt carrier: pi operating instructions plus project AGENTS.md context",
	);
	assert.equal(fm.mainAgent, true);
	assert.equal(fm.model, "inherit");
});

test("carrier declares native subagent masking explicitly (issue #7)", () => {
	// Probe-verified 2026-10-20: agent-file presence already suppresses agy's
	// native subagent tools. Pin the explicit frontmatter so the suppression
	// is declared, not an undocumented accident.
	const fm = parseAgentFrontmatter(syspromptAgentMd("pi-bridge-sys-x", "BODY"));
	assert.equal(fm.subagent, false);
	assert.deepEqual(fm.agents, []);
});

test("stageSyspromptAgent writes agent.md + pid marker and returns the name", () => {
	const root = tmpAgentsRoot();
	const name = stageSyspromptAgent("BODY-ONE", { agentsRoot: root });
	assert.ok(name?.startsWith("pi-bridge-sys-"));
	const md = fs.readFileSync(path.join(root, name!, "agent.md"), "utf8");
	assert.ok(md.includes("BODY-ONE"));
	const pid = fs.readFileSync(path.join(root, name!, ".pid"), "utf8");
	assert.equal(pid.trim(), String(process.pid));
});

test("same body reuses its dir; a different body gets its own (no clobber)", () => {
	const root = tmpAgentsRoot();
	// Same body twice: the content-addressed cache reuses the dir; identical
	// bytes are never rewritten.
	const a1 = stageSyspromptAgent("BODY-ONE", { agentsRoot: root });
	const a2 = stageSyspromptAgent("BODY-ONE", { agentsRoot: root });
	assert.equal(a1, a2);
	// A different body MUST NOT overwrite the first conversation's carrier:
	// a shared file would leak one conversation's instructions into the
	// other's respawned agy process (peer-review blocker, 2026-09-30).
	const b1 = stageSyspromptAgent("BODY-TWO", { agentsRoot: root });
	assert.ok(b1?.startsWith("pi-bridge-sys-"));
	assert.notEqual(a1, b1);
	const mdA = fs.readFileSync(path.join(root, a1!, "agent.md"), "utf8");
	assert.ok(mdA.includes("BODY-ONE"));
	assert.equal(mdA.includes("BODY-TWO"), false);
	const mdB = fs.readFileSync(path.join(root, b1!, "agent.md"), "utf8");
	assert.ok(mdB.includes("BODY-TWO"));
	assert.equal(mdB.includes("BODY-ONE"), false);
	// Both dirs carry this process's pid marker for the orphan sweep.
	for (const name of [a1!, b1!]) {
		const pid = fs.readFileSync(path.join(root, name, ".pid"), "utf8");
		assert.equal(pid.trim(), String(process.pid));
	}
	// Restaging the first body after the interleaved second keeps returning
	// the SAME name: a conversation's agent field must never flip mid-flight.
	assert.equal(stageSyspromptAgent("BODY-ONE", { agentsRoot: root }), a1);
});

test("staging failure returns null instead of throwing", () => {
	// A file where the root should be forces mkdir to fail.
	const bad = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sys-bad-"));
	const blocker = path.join(bad, "blocker");
	fs.writeFileSync(blocker, "not a dir");
	const name = stageSyspromptAgent("BODY", { agentsRoot: path.join(blocker, "agents") });
	assert.equal(name, null);
	// The failure must not poison the cache for a later good root.
	const root = tmpAgentsRoot();
	assert.ok(stageSyspromptAgent("BODY", { agentsRoot: root })?.startsWith("pi-bridge-sys-"));
	fs.rmSync(bad, { recursive: true, force: true });
});
