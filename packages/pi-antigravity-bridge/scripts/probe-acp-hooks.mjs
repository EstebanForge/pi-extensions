// Live probe (issue #18): does the agy ACP server honor PreToolUse hooks from
// any channel the bridge could deliver? The approval gate stages hooks.json
// into a per-pid dir that only the stream-json engine receives via --add-dir.
// The ACP engine gets a staged home via --gemini-dir, so the candidate
// channels are: hooks.json under the staged home's config/ (stageAgyHome
// copies config/* except mcp_config.json - this is the only injection point
// the bridge controls), an --add-dir passthrough on the acp argv, and the
// user's workspace .agents/hooks.json (the reporter's known-good location,
// used here as the POSITIVE CONTROL that validates the probe machinery).
//
// Gated: AGY_ACP_LIVE=1 (spends a small amount of quota; four flash turns).
//
//   AGY_ACP_LIVE=1 npx tsx scripts/probe-acp-hooks.mjs
//
// Variants (AGY_PROBE_VARIANTS=workspace,config,adddir,control to subset):
//   workspace: hooks.json in the turn's cwd - MUST fire (positive control)
//   config:    hooks.json in the fake gemini home's config/ (staged through
//              the same stageAgyHome path production uses)
//   adddir:    hooks.json under a --add-dir passed to `agy acp`
//   control:   no hooks anywhere - MUST stay silent
// Each variant's PreToolUse hook writes its own marker file inside the turn's
// cwd; the check reads that exact path, so a fired hook is unambiguous. Turns
// where the model never calls run_command are reported inconclusive. Temp
// dirs are left behind for post-mortem; driver logs (raw payload text) go to
// stderr.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpDriver } from "../src/acp/driver.js";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}

const bin = process.env.AGY_BIN || "agy";
const realGemini = path.join(os.homedir(), ".gemini");

// Mirror stageAgyHome's home staging so auth state reaches the probe home the
// same way production stages it: appData linked, GEMINI.md copied, config/
// carried (mcp_config.json excluded upstream).
function makeProbeHome() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hooks-probe-home-"));
	if (fs.existsSync(path.join(realGemini, "antigravity-cli"))) {
		fs.symlinkSync(path.join(realGemini, "antigravity-cli"), path.join(home, "antigravity-cli"), "dir");
	}
	const instructions = path.join(realGemini, "GEMINI.md");
	if (fs.existsSync(instructions)) fs.copyFileSync(instructions, path.join(home, "GEMINI.md"));
	return home;
}

// Same group shape the gate stages (buildGateGroup) - the workspace variant
// doubles it as the reporter's proven shape.
function hookGroup(markerPath) {
	return {
		"probe-gate": {
			enabled: true,
			PreToolUse: [
				{
					matcher: "run_command",
					hooks: [
						{
							type: "command",
							command: `node -e 'require("fs").writeFileSync(${JSON.stringify(markerPath)}, "fired")'`,
							timeout: 60,
						},
					],
				},
			],
		},
	};
}

async function runVariant(label, build = {}) {
	// runVariant owns the marker path and hands it to the variant builders, so
	// the baked command path and the checked path cannot drift apart (the
	// workspace control fires through this exact path, validating machinery
	// on every run).
	const home = makeProbeHome();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `agy-hooks-probe-cwd-${label}-`));
	const marker = path.join(cwd, `marker-${label}`);
	const addDir = build.addDir ? build.addDir(marker) : undefined;
	if (build.homeHooks) {
		const target = path.join(home, build.homeHooks.where, "hooks.json");
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		fs.writeFileSync(target, JSON.stringify(build.homeHooks.body(marker), null, 2), { mode: 0o600 });
	}
	let workspaceWritten = false;
	if (build.workspaceHooks) {
		fs.mkdirSync(path.join(cwd, ".agents"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".agents", "hooks.json"), JSON.stringify(hookGroup(marker), null, 2));
		workspaceWritten = true;
	}
	const toolStarts = [];
	const binArgs = ["acp", ...(addDir ? ["--add-dir", addDir] : [])];
	const driver = new AcpDriver({
		bin,
		binArgs,
		isolateHome: { geminiHome: home },
		log: (msg, data) => console.error(`[${label}] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`),
	});
	let outcome;
	try {
		const handle = await driver.run({
			cwd,
			model: process.env.AGY_PROBE_MODEL || "gemini-3.8-flash",
			effort: "low",
			mode: "accept-edits",
			skipPermissions: true,
			prompt:
				"Run this exact shell command: echo probe-ok. Reply with the command's output and nothing else. You must use the shell command tool to run it.",
			signal: new AbortController().signal,
			timeoutMin: 4,
		});
		const collecting = (async () => {
			for (;;) {
				const activity = await handle.next();
				if (activity === null) return;
				if (activity.type === "tool_start") toolStarts.push(activity.name);
			}
		})();
		outcome = await handle.outcome;
		await collecting;
	} finally {
		await driver.close("shutdown");
	}
	const fired = fs.existsSync(marker);
	const called = toolStarts.some((n) => n === "run_command");
	console.log(
		`[${label}] status=${outcome.status} run_command_seen=${called} hook_marker=${fired ? "FIRED" : "absent"}${workspaceWritten ? " (workspace hooks staged)" : ""}`,
	);
	return { called, fired };
}

const wanted = (process.env.AGY_PROBE_VARIANTS || "workspace,config,adddir,control").split(",");
const run = (label, opts) => (wanted.includes(label) ? runVariant(label, opts) : { called: null, fired: null });

const results = {};
results.workspace = await run("workspace", { workspaceHooks: true });
results.config = await run("config", {
	// The hook rides stageAgyHome's config/ copy (the only injection point the
	// bridge controls on the staged home); runVariant bakes the marker into
	// the body and checks that same path inside the turn cwd.
	homeHooks: { where: "config", body: (marker) => hookGroup(marker) },
});
results.adddir = await run("adddir", {
	addDir: (marker) => {
		const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hooks-probe-gatedir-"));
		fs.mkdirSync(path.join(gateDir, ".agents"), { recursive: true });
		fs.writeFileSync(path.join(gateDir, ".agents", "hooks.json"), JSON.stringify(hookGroup(marker), null, 2));
		return gateDir;
	},
});
results.control = await run("control");

console.log("\n[probe] verdict:");
for (const label of ["workspace", "config", "adddir", "control"]) {
	const r = results[label];
	console.log(`  ${label.padEnd(10)}: run_command=${r.called} marker=${r.fired}${r.called === false ? "  INCONCLUSIVE: run_command never called" : ""}`);
}
if (results.workspace.called && !results.workspace.fired) {
	console.log("  INVALID: the positive control called run_command but did not fire; probe machinery is broken.");
} else if (results.workspace.fired) {
	console.log("  positive control FIRED: probe machinery validated.");
}
if (results.control.fired) console.log("  INVALID: control fired a marker with no hooks staged.");
