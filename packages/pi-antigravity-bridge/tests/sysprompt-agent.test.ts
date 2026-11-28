// Unit tests for src/sysprompt-agent.ts (G10 staged carrier agent).
// AGY_AGENTS_ROOT / opts.agentsRoot keeps every write inside a tmpdir.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
	ACP_TOOL_NOTE,
	CODEMODE_NOTE,
	SYSTEM_PROMPT_PREAMBLE,
	TOOL_PRIORITY_NOTE,
} from "../src/provider.js";
import {
	carrierSafeBody,
	carrierScrubInfo,
	PI_DOCS_INDEX_PREFIX,
	PI_OPENING,
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
	// bridge MCP config for G9 round-trips.
	assert.equal(md.includes("excludeDefaultComponents"), false);
	assert.equal(md.includes("inheritMcp"), false);
	assert.ok(md.endsWith("BODY\n"));
});

test("carrier declares the productive toolset explicitly (issue #13)", () => {
	// Omitting tools: is not "all tools" - agy then grants a small read-only
	// default set (official migrate-agent-settings guidance: always write
	// it), which cost carrier sessions every write/edit/command tool. agy
	// appends the resource/MCP tools on its own, so the G9 bridge round-trips
	// do not depend on this list.
	const fm = parseAgentFrontmatter(syspromptAgentMd("pi-bridge-sys-x", "BODY"));
	assert.deepEqual(fm.tools, [
		"read_file",
		"edit_file",
		"write_file",
		"run_command",
		"manage_task",
		"search_web",
	]);
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

test("carrier body rewords pi's opening sentence, which trips a backend 429", () => {
	const body =
		"PREAMBLE\n\nYou are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.\n\nREST";
	const md = syspromptAgentMd("pi-bridge-sys-x", body);
	assert.equal(md.includes("running inside pi, a coding agent harness"), false);
	assert.ok(
		md.includes(
			"You are a coding assistant running inside the pi coding agent harness. Help users inspect files, run commands, and modify code.",
		),
	);
	assert.ok(md.includes("PREAMBLE\n"));
	assert.ok(md.endsWith("REST\n"));
});

test("carrier body drops pi's docs-index line, which trips the same 429", () => {
	const body = [
		"- Examples: /x/examples (extensions, custom tools, SDK)",
		"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md)",
		"- Before implementing harness changes, read the relevant docs.",
	].join("\n");
	assert.equal(
		carrierSafeBody(body),
		"- Examples: /x/examples (extensions, custom tools, SDK)\n- Before implementing harness changes, read the relevant docs.",
	);
});

test("carrier body leaves a custom system prompt untouched", () => {
	const body = "You are a reviewer running inside pi.\n\n- When asked about: billing, answer briefly.\n";
	assert.equal(carrierSafeBody(body), body);
	assert.ok(syspromptAgentMd("pi-bridge-sys-x", body).endsWith(`${body}\n`));
});

test("carrierScrubInfo reports which scrubs a body needed (issue #30 telemetry)", () => {
	const both = carrierScrubInfo(
		"You are a coding assistant running inside pi, a coding agent harness.\n- When asked about: extensions (docs/extensions.md), themes (docs/themes.md)",
	);
	assert.equal(both.opening, true);
	assert.equal(both.docsLine, true);
	assert.equal(both.text.includes(PI_OPENING), false);
	const opening = carrierScrubInfo(`PREAMBLE\n\n... ${PI_OPENING}. ...`);
	assert.equal(opening.opening, true);
	assert.equal(opening.docsLine, false);
	const docs = carrierScrubInfo(`keep\n${PI_DOCS_INDEX_PREFIX}extensions (docs/extensions.md)\nafter`);
	assert.equal(docs.opening, false);
	assert.equal(docs.docsLine, true);
	assert.ok(docs.text.startsWith("keep\n"));
	assert.ok(docs.text.endsWith("\nafter"));
	const clean = carrierScrubInfo("You are a billing assistant.");
	assert.equal(clean.opening, false);
	assert.equal(clean.docsLine, false);
	assert.equal(clean.text, "You are a billing assistant.");
	// The phrase sitting only inside a dropped docs line reports no reword.
	const buried = carrierScrubInfo(`${PI_DOCS_INDEX_PREFIX}docs, e.g. ${PI_OPENING}`);
	assert.equal(buried.opening, false);
	assert.equal(buried.docsLine, true);
	assert.equal(buried.text, "");
});

test("staged agent.md holds the safe body while the dir name keys on the original (issue #30)", () => {
	const root = tmpAgentsRoot();
	const body = [
		"PREAMBLE",
		"",
		"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
		"",
		"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md)",
	].join("\n\n");
	const name = stageSyspromptAgent(body, { agentsRoot: root });
	assert.ok(name);
	// The cache key stays the ORIGINAL body's hash: the scrub is a pure
	// function of the body, so a hash hit always replays the same safe text.
	const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
	assert.ok(name.includes(hash), `expected ${hash} in ${name}`);
	const md = fs.readFileSync(path.join(root, name!, "agent.md"), "utf8");
	assert.equal(md.includes(PI_OPENING), false);
	assert.equal(md.includes("When asked about: extensions"), false);
	assert.ok(md.includes("running inside the pi coding agent harness. Help users inspect files"));
	assert.ok(md.includes("PREAMBLE"));
});

test("bridge carrier constants stay free of the issue #30 trigger strings", () => {
	// Any of the bridge's own carrier-bound text reintroducing a trigger
	// string would 429 every stream-json carrier turn again (issue #30).
	for (const constant of [SYSTEM_PROMPT_PREAMBLE, TOOL_PRIORITY_NOTE, ACP_TOOL_NOTE, CODEMODE_NOTE]) {
		assert.equal(constant.includes(PI_OPENING), false);
		assert.equal(
			constant.split("\n").some((line) => line.startsWith(PI_DOCS_INDEX_PREFIX)),
			false,
			`constant carries the docs-index prefix: ${constant.slice(0, 60)}`,
		);
	}
});

test("a pi-default-shaped prompt scrubs exactly the two trigger lines (issue #30)", () => {
	const body = [
		"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
		"",
		"<env>",
		"  Working directory: /home/user/project",
		"</env>",
		"",
		"Pi documentation (read only when the user asks about the harness itself):",
		"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md)",
		"- When asked about keybindings, read docs/keybindings.md.",
		"",
		"Follow the AGENTS.md instructions.",
	].join("\n");
	const safe = carrierSafeBody(body);
	assert.equal(safe.includes(PI_OPENING), false);
	assert.equal(safe.includes("When asked about: extensions"), false);
	assert.ok(safe.includes("running inside the pi coding agent harness. Help users inspect files"));
	// A near-miss doc bullet that does not start the index line survives.
	assert.ok(safe.includes("- When asked about keybindings, read docs/keybindings.md."));
	assert.ok(safe.includes("Follow the AGENTS.md instructions."));
});
