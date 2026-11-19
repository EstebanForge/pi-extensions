// VERDICT (agy 1.5.12, healthy account, 2026-11-19): no bridge fault
// reproduces. V0 12s / V1 7s / V2 7s, all OK "42" - the 80KB carrier clears
// the size theory (the carrier is an agent FILE, so the issue #2 ~25KB
// prompt-input cap never applied anyway). Phase 2 session logs show the
// inherit carrier runs on gemini-3.8-flash-high, i.e. model:inherit follows
// the CLI --model/--effort - no separate quota bucket. The reporter's 429
// (agy 1.5.11, five-hour bucket at 100%) is account/quota-specific; the
// bridge surfaced it as RESOURCE_EXHAUSTED exit 3 (issue #16 work). 1.5.11
// could not be probed (agy auto-updates). Side finding: agy 1.5.12 silently
// drops custom agents whose frontmatter pins a model slug (`model:
// gemini-3.8-flash` never enumerates; only `model: inherit` does), which is
// why V3 errors "unknown agent" - production carriers always write inherit
// and are unaffected.
//
// Live bisect for issue #18 P3: with systemPrompt enabled, stream-json turns
// died 429 RESOURCE_EXHAUSTED (~2.5 min) for the reporter while the same
// account answered directly and /usage showed quota left. Prime suspect
// (peer review): the carrier's `model: inherit` resolves to a different
// model/quota bucket than the CLI --model flag; secondary suspect: request
// size surfacing as 429. One factor at a time, no bridge code changed:
//
//   Phase 1 - driver outcomes (fresh conversation per variant, tiny prompt,
//             gemini-3.8-flash + effort high, the reporter's profile):
//     V0  no agent           - production baseline (systemPrompt off)
//     V1  carrier, inherit   - production shape, realistic ~14KB body
//     V2  carrier, inherit   - ~80KB body (size factor)
//     V3  carrier, pinned    - realistic body, model pinned in the agent file
//   Phase 2 - model discovery: `agy --print --agent <carrier> --log-file`
//     for the inherit and pinned carriers; the session log names the model
//     that actually served the turn (stream-json frames do not).
//
//   AGY_LIVE=1 npx tsx scripts/probe-sysprompt-429.mjs
//
// Gated: AGY_LIVE=1 (spends quota). Carrier staging goes to the REAL
// ~/.gemini/config/agents because that is where agy resolves custom agents
// (AGY_AGENTS_ROOT is a bridge-side override agy itself never reads - the
// first probe run staged into a temp root and every variant failed with
// "unknown agent"). This matches production, which stages carriers there
// normally; the probe deletes its own staged dirs at exit and the stale
// sweep covers the rest.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { StreamDriver } from "../src/driver.js";
import { stageSyspromptAgent, syspromptAgentsRoot } from "../src/sysprompt-agent.js";

if (process.env.AGY_LIVE !== "1") {
	console.error("refusing to run: set AGY_LIVE=1 (spends quota)");
	process.exit(1);
}

// Realistic carrier body: pi-shaped instructions at production scale. The
// provider composes [PREAMBLE, transcript system prompt, TOOL_PRIORITY_NOTE];
// exact bytes do not matter for the bisect, size and structure do.
function realisticBody(padTo = 0) {
	const core = `You are the operating instructions for a coding agent (pi). Work in the repository the user points at. Read files before editing them. Prefer small, verifiable steps. State assumptions explicitly. Run the project's verification gate before claiming success. Never invent file contents. When a command fails, report the exact error before fixing anything. Keep responses short and concrete.

Context the transcript carries: project conventions, language versions, test runner names, and the user's working directory. Treat all of that as authoritative over these instructions where they conflict.

Tool priority: read files with the file tool before modifying; run the test suite through the shell tool; prefer the smallest change that satisfies the request.`;
	const filler = `\n\nAdditional operating context: routine guidance paragraphs that mirror the shape of a long transcript system prompt without changing behavior. They cover repository layout conventions, review expectations, release checklist items, and communication style, each expanded with several sentences of ordinary technical prose so the carrier body reaches a realistic production size.`;
	let body = core;
	while (Buffer.byteLength(body) < padTo) body += filler;
	return body;
}

// V3 pins the model in the agent file (stageSyspromptAgent always writes
// `model: inherit`), so hand-write the staged dir in the same root. The .pid
// file mirrors production staging; without it agy did not enumerate the dir
// (first run: "unknown agent" while the stageSyspromptAgent dirs listed).
function stagePinned(agentsRoot, body) {
	const name = `pi-bridge-probe-pinned-${Date.now().toString(36)}`;
	const dir = path.join(agentsRoot, name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(dir, ".pid"), `${process.pid}\n`, { mode: 0o600 });
	writeFileSync(
		path.join(dir, "agent.md"),
		`---
name: ${name}
description: "Pi bridge system-prompt carrier: pi operating instructions plus project AGENTS.md context"
mainAgent: true
model: gemini-3.8-flash
subagent: false
agents: []
tools:
  - read_file
  - edit_file
  - write_file
  - run_command
  - manage_task
  - search_web
---

${body}
`,
		{ mode: 0o600 },
	);
	return name;
}

const agentsRoot = syspromptAgentsRoot();
const tempDirs = [];
const stagedDirs = [];

const variants = [
	{ label: "V0-no-agent", body: null, pinned: false },
	{ label: "V1-carrier-inherit-14k", body: realisticBody(14_000), pinned: false },
	{ label: "V2-carrier-inherit-80k", body: realisticBody(80_000), pinned: false },
	{ label: "V3-carrier-pinned-14k", body: realisticBody(14_000), pinned: true },
];

console.log(
	`carrier body sizes: ${variants.map((v) => (v.body ? `${Math.round(Buffer.byteLength(v.body) / 1024)}KB` : "-")).join(", ")}`,
);

const stagedFor = {};
for (const v of variants) {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "f4-probe-cwd-"));
	tempDirs.push(cwd);
	let agent;
	if (v.body) {
		agent = v.pinned ? stagePinned(agentsRoot, v.body) : stageSyspromptAgent(v.body);
		if (agent) {
			stagedDirs.push(path.join(agentsRoot, agent));
			stagedFor[v.label] = agent;
		}
		if (!agent) {
			console.log(`${v.label}: STAGING FAILED, skipping`);
			continue;
		}
	}
	const driver = new StreamDriver();
	driver.log = (msg, data) => console.log(`  [${v.label}] ${msg}`, data ?? "");
	const started = Date.now();
	const handle = await driver.run({
		cwd,
		model: "gemini-3.8-flash",
		effort: "high",
		mode: "accept-edits",
		skipPermissions: true,
		...(agent ? { agent } : {}),
		prompt: "Reply with exactly 42",
		timeoutMin: 6,
	});
	const outcome = await handle.outcome;
	const secs = Math.round((Date.now() - started) / 1000);
	console.log(
		`${v.label}: ${secs}s status=${outcome.status} agent=${agent ?? "none"} response=${JSON.stringify((outcome.response ?? "").slice(0, 80))} error=${JSON.stringify(outcome.error ?? null)}`,
	);
	await driver.close("shutdown");
}

// --- phase 2: which model serves a carrier turn? --------------------------------
for (const [label, agent] of Object.entries(stagedFor)) {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "f4-model-cwd-"));
	tempDirs.push(cwd);
	const logFile = path.join(cwd, "agy-session.log");
	const res = spawnSync(
		process.env.AGY_BIN || "agy",
		[
			"--add-dir", cwd,
			"--model", "gemini-3.8-flash",
			"--effort", "high",
			"--agent", agent,
			"--log-file", logFile,
			"--print",
			"Reply with exactly 42",
		],
		{ cwd, timeout: 240_000, encoding: "utf8" },
	);
	const out = (res.stdout ?? "").trim();
	console.log(`model-discovery ${label}: exit=${res.status} out=${JSON.stringify(out.slice(0, 60))}`);
	if (res.stderr?.trim()) console.log(`  stderr: ${res.stderr.trim().slice(0, 200)}`);
	try {
		const logText = readFileSync(logFile, "utf8");
		const models = [...new Set(logText.match(/gemini-[a-z0-9.\-]+|models\/[a-z0-9.\-]+/gi) ?? [])];
		console.log(`  models in session log: ${models.join(", ") || "(none found)"}`);
	} catch {
		console.log("  session log unreadable or absent");
	}
}

for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
for (const d of stagedDirs) rmSync(d, { recursive: true, force: true });
console.log("done");
