// Live probe: does an ACP turn accept the native xhigh tier end to end?
// The catalog (agy 1.5.16) lists gemini-4-{hydrogen,neon}-xhigh slugs and
// independent reports say the engine serves a native xhigh thinking level;
// our provider clamps xhigh -> high (toAgyEffort) and TIER_RE cannot split
// -xhigh slugs. This probe sends one tiny turn with the qualified xhigh
// slug and inspects the session log for the tier that actually served it.
//
//   AGY_ACP_LIVE=1 npx tsx scripts/probe-xhigh.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpDriver } from "../src/acp/driver.js";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}

const model = process.env.AGY_PROBE_MODEL || "gemini-4-hydrogen-xhigh";
const driver = new AcpDriver({
	bin: process.env.AGY_BIN || "agy",
	binArgs: ["acp"],
	isolateHome: true,
	log: () => {},
});

const controller = new AbortController();
let out = "";
const handle = await driver.run({
	cwd: process.cwd(),
	model,
	effort: "low",
	mode: "accept-edits",
	skipPermissions: true,
	prompt: "Reply with the single word: ok",
	signal: controller.signal,
	timeoutMin: 4,
	inactivityMin: 3,
});
const collecting = (async () => {
	for (;;) {
		const activity = await handle.next();
		if (activity === null) return;
		if (activity.type === "text") out += activity.delta;
	}
})();
const outcome = await handle.outcome;
await collecting;
await driver.close("shutdown");

// The session log names the model that served the turn (established by the
// issue #18 phase-2 probe). agy writes session logs under the agy home.
const home = path.join(os.homedir(), ".agy");
let logLine = "";
try {
	const latest = execFileSync("bash", [
		"-c",
		`grep -rhoE 'gemini-[a-z0-9]+-(xhigh|high|medium|low)' ~/.agy -r --include='*.jsonl' --include='*.log' 2>/dev/null | tail -3 | tr '\\n' ' '`,
	]).toString().trim();
	logLine = latest;
} catch {
	logLine = "(log grep failed)";
}

console.log(`[probe] model sent: ${model}`);
console.log(`[probe] status: ${outcome.status} reply: ${JSON.stringify(out.slice(0, 60))}`);
console.log(`[probe] recent agy-log model mentions: ${logLine}`);
console.log(`[probe] VERDICT: ${outcome.status === "OK" ? "xhigh slug accepted by the engine path" : "REJECTED - inspect outcome"}`);
process.exit(outcome.status === "OK" ? 0 : 1);
