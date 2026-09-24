// Unit tests for the agy agent roster (src/agents.ts) and the agent config
// knob. Parse tests pin the live-verified `agy agent` output shape (bare
// names, agy 1.2.10) plus tolerant extras (banner lines, description
// columns). Subprocess tests run fake binaries; no real agy needed.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	isValidAgyAgentName,
	listAgyAgents,
	normalizeAgyAgentName,
	parseAgyAgentsRaw,
} from "../src/agents.js";
import { loadConfig, saveConfig } from "../src/config.js";

/** A fake binary printing `output` to stdout and exiting 0. %b so \n escapes
 *  in the shell-quoted argument become real newlines. */
function makeFakeBinary(output: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agents-fake-"));
	const bin = path.join(dir, "agy");
	fs.writeFileSync(bin, `#!/bin/sh\nprintf '%b' ${JSON.stringify(output)}\n`, {
		mode: 0o755,
	});
	return bin;
}

function tmpConfig(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-agents-cfg-")), "config.json");
}

// --- parseAgyAgentsRaw -------------------------------------------------------

test("parseAgyAgentsRaw: live-verified bare-name listing", () => {
	assert.deepEqual(parseAgyAgentsRaw("pi-probe-agent\n"), ["pi-probe-agent"]);
	assert.deepEqual(parseAgyAgentsRaw("reviewer\nplanner\n"), ["reviewer", "planner"]);
	// No trailing newline (printf-style output).
	assert.deepEqual(parseAgyAgentsRaw("a.b_c-1"), ["a.b_c-1"]);
});

test("parseAgyAgentsRaw: empty and blank output", () => {
	assert.deepEqual(parseAgyAgentsRaw(""), []);
	assert.deepEqual(parseAgyAgentsRaw("\n\n"), []);
});

test("parseAgyAgentsRaw: skips banner and help lines", () => {
	assert.deepEqual(
		parseAgyAgentsRaw("Usage: agy agent [flags]\nList available agents\nFlags:\nreviewer\n"),
		["reviewer"],
	);
	// Older banner formats stay noise.
	assert.deepEqual(parseAgyAgentsRaw("available agents:\nreviewer\n"), ["reviewer"]);
	assert.deepEqual(parseAgyAgentsRaw("Available Agents:\nreviewer\n"), ["reviewer"]);
});

test("parseAgyAgentsRaw: takes the first token when a description column exists", () => {
	assert.deepEqual(parseAgyAgentsRaw("reviewer  Code review agent\nplanner\tPlans work\n"), [
		"reviewer",
		"planner",
	]);
});

test("parseAgyAgentsRaw: rejects invalid tokens and dedupes", () => {
	// Control characters and a leading dash are not agent-dir names.
	assert.deepEqual(parseAgyAgentsRaw("-flag\nreviewer\nreviewer\na\x01b\n"), ["reviewer"]);
	assert.deepEqual(parseAgyAgentsRaw("reviewer\nreviewer\n"), ["reviewer"]);
});

// --- isValidAgyAgentName -----------------------------------------------------

test("isValidAgyAgentName: token rules", () => {
	assert.equal(isValidAgyAgentName("reviewer"), true);
	assert.equal(isValidAgyAgentName("pi-bridge-web-x"), true);
	assert.equal(isValidAgyAgentName("a".repeat(128)), true);
	assert.equal(isValidAgyAgentName(""), false);
	assert.equal(isValidAgyAgentName("-leading-dash"), false);
	assert.equal(isValidAgyAgentName("has space"), false);
	assert.equal(isValidAgyAgentName("a".repeat(129)), false);
	assert.equal(isValidAgyAgentName("tab\tname"), false);
});

// --- normalizeAgyAgentName ---------------------------------------------------

test("normalizeAgyAgentName: trim, strip controls, cap; empty means unset", () => {
	assert.equal(normalizeAgyAgentName("  reviewer \n"), "reviewer");
	assert.equal(normalizeAgyAgentName("re\x01viewer"), "reviewer");
	const capped = normalizeAgyAgentName(`a${"b".repeat(200)}`);
	assert.ok(capped !== undefined);
	assert.equal(capped.length, 128);
	assert.equal(normalizeAgyAgentName("   "), undefined);
	assert.equal(normalizeAgyAgentName(undefined), undefined);
});

// --- listAgyAgents (fake binaries) -------------------------------------------

test("listAgyAgents: end-to-end against a fake binary", async () => {
	const bin = makeFakeBinary("reviewer\nplanner\n");
	assert.deepEqual(await listAgyAgents(bin), ["reviewer", "planner"]);
});

test("listAgyAgents: missing binary degrades to no agents", async () => {
	const missing = path.join(os.tmpdir(), `agy-missing-${process.pid}-${Math.random()}`);
	assert.deepEqual(await listAgyAgents(missing), []);
});

// --- config agent knob -------------------------------------------------------

test("config: agent round-trips through load/save and clears via undefined", () => {
	const p = tmpConfig();
	try {
		assert.equal(loadConfig(p).agent, undefined);
		saveConfig({ agent: "reviewer" }, p);
		assert.equal(loadConfig(p).agent, "reviewer");
		// Unrelated saves never clobber it (the merge regression class).
		saveConfig({ mode: "plan" }, p);
		assert.equal(loadConfig(p).agent, "reviewer");
		// Explicit undefined clears (JSON drops the key; load falls back to
		// no agent).
		saveConfig({ agent: undefined }, p);
		assert.equal(loadConfig(p).agent, undefined);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: AGY_AGENT env overrides the file and normalizes", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_AGENT;
	try {
		saveConfig({ agent: "reviewer" }, p);
		process.env.AGY_AGENT = "  planner  ";
		assert.equal(loadConfig(p).agent, "planner");
		// Empty env value means unset, not a nameless agent.
		process.env.AGY_AGENT = "   ";
		assert.equal(loadConfig(p).agent, undefined);
	} finally {
		if (prev === undefined) delete process.env.AGY_AGENT;
		else process.env.AGY_AGENT = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});
