// VERDICT (agy 1.5.12, healthy account, 2026-11-19): no bridge fault
// reproduces. V0 12s / V1 7s / V2 7s, all OK "42" - the 80KB carrier clears
// the size theory (the carrier is an agent FILE, so the issue #2 ~25KB
// prompt-input cap never applied anyway). Session logs show the inherit
// carrier runs on gemini-3.8-flash-high exactly as the CLI --model/--effort
// spell, and the follow-up run through a STAGED home (production's
// --gemini_dir path) at --effort low resolved to gemini-3.8-flash-low, so
// inherit follows the CLI flags rather than any fixed default. The
// reporter's 429s are NOT explained by anything probed here: their /usage
// showed 99% weekly and 100% five-hour quota REMAINING, so plain exhaustion
// does not explain it either - cause unidentified, agy 1.5.11 unprobed
// (agy auto-updates). The bridge surfaced the 429s as RESOURCE_EXHAUSTED
// exit 3 (issue #16 work), which is the correct observable behavior.
// Side finding: agy 1.5.12 silently drops custom agents whose frontmatter
// pins a model slug (`model: gemini-3.8-flash` never enumerates; only
// `model: inherit` does), which is why V3 errors "unknown agent" -
// production carriers always write inherit and are unaffected.
//
// Live bisect for issue #18 P3: with systemPrompt enabled, stream-json turns
// died 429 RESOURCE_EXHAUSTED (~2.5 min) for the reporter while the same
// account answered directly and /usage showed quota remaining. Prime suspect
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
//   Phase 2 - model discovery: `agy --print --agent <carrier> --log-file`;
//     the session log names the model that actually served the turn
//     (stream-json frames do not). Variant B stages a production-shaped
//     home (stageAgyHome) and runs --effort low to test both staged-home
//     agent resolution and effort inheritance in one turn.
//
//   AGY_LIVE=1 npx tsx scripts/probe-sysprompt-429.mjs            # both phases
//   AGY_LIVE=1 AGY_PROBE_PHASE=2 npx tsx scripts/probe-sysprompt-429.mjs
//
// Gated: AGY_LIVE=1 (spends quota). Carrier staging goes to the REAL
// ~/.gemini/config/agents because that is where agy resolves custom agents
// (AGY_AGENTS_ROOT is a bridge-side override agy itself never reads - the
// first probe run staged into a temp root and every variant failed with
// "unknown agent"). This matches production, which stages carriers there
// normally; the probe deletes its own staged dirs at exit (try/finally) and
// the stale sweep covers the rest.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StreamDriver } from "../src/driver.js";
import { stageSyspromptAgent, syspromptAgentsRoot } from "../src/sysprompt-agent.js";
import { stageAgyHome } from "../src/acp/home.js";

if (process.env.AGY_LIVE !== "1") {
	console.error("refusing to run: set AGY_LIVE=1 (spends quota)");
	process.exit(1);
}
const phase = process.env.AGY_PROBE_PHASE === "1" || process.env.AGY_PROBE_PHASE === "2" ? process.env.AGY_PROBE_PHASE : "both";

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
// file mirrors production staging. agy 1.5.12 drops pinned-model agent files
// at enumeration (see VERDICT), so V3 always errors "unknown agent"; kept so
// the probe documents that behavior against future agy versions.
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

async function main() {
	console.log(
		`phase=${phase}; carrier body sizes: ${variants.map((v) => (v.body ? `${Math.round(Buffer.byteLength(v.body) / 1024)}KB` : "-")).join(", ")}`,
	);

	const stagedFor = {};
	if (phase !== "2") {
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
	}

	// --- phase 2: which model serves a carrier turn? ---------------------------
	if (phase !== "1") {
		let carrier = stagedFor["V1-carrier-inherit-14k"];
		if (!carrier) {
			const agent = stageSyspromptAgent(realisticBody(14_000));
			if (agent) {
				stagedDirs.push(path.join(agentsRoot, agent));
				carrier = agent;
			}
		}
		if (!carrier) throw new Error("carrier staging failed; cannot run phase 2");

		const runs = [
			// Staged home (production's --gemini_dir path) + --effort low:
			// proves staged-home agent resolution AND effort inheritance.
			{ label: "staged-home-effort-low", effort: "low", stage: true },
		];
		for (const run of runs) {
			const cwd = mkdtempSync(path.join(os.tmpdir(), "f4-model-cwd-"));
			tempDirs.push(cwd);
			const logFile = path.join(cwd, "agy-session.log");
			const args = ["--add-dir", cwd, "--model", "gemini-3.8-flash", "--effort", run.effort];
			if (run.stage) {
				const home = stageAgyHome({ parentDir: mkdtempSync(path.join(os.tmpdir(), "f4-stage-home-")) });
				tempDirs.push(home);
				args.push("--gemini_dir", home);
			}
			args.push("--agent", carrier, "--log-file", logFile, "--print", "Reply with exactly 42");
			const res = spawnSync(process.env.AGY_BIN || "agy", args, { cwd, timeout: 240_000, encoding: "utf8" });
			const out = (res.stdout ?? "").trim();
			console.log(`model-discovery ${run.label}: exit=${res.status} out=${JSON.stringify(out.slice(0, 60))}`);
			if (res.stderr?.trim()) console.log(`  stderr: ${res.stderr.trim().slice(0, 200)}`);
			try {
				const models = [...new Set(readFileSync(logFile, "utf8").match(/gemini-[a-z0-9.\-]+|models\/[a-z0-9.\-]+/gi) ?? [])];
				console.log(`  models in session log: ${models.join(", ") || "(none found)"}`);
			} catch {
				console.log("  session log unreadable or absent");
			}
		}
	}
}

try {
	await main();
} finally {
	for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
	for (const d of stagedDirs) rmSync(d, { recursive: true, force: true });
}
console.log("done");
