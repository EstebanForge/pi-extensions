// Live calibration probe for issue #12: PromptResponse.usage vs usage_update
// occupancy. Gated: AGY_ACP_LIVE=1 (spends quota).
//
//   AGY_ACP_LIVE=1 npx tsx scripts/probe-acp-usage.mjs
//
// Runs ONE tool round-trip prompt over a raw AcpConnection, logs every raw
// frame to probe-logs/acp-usage-traffic.jsonl, then cross-checks:
//   1. usage_update frames: count, `used` sequence, final occupancy
//   2. PromptResponse.usage aggregate vs the brain transcript's per-step
//      PLANNER_RESPONSE sums (the issue #12 hypothesis, on this agy build)
//   3. final occupancy vs the last step's true context, to test whether agy
//      adds the cache reads to `used` twice (the prior-art subtraction)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AcpConnection } from "../src/acp/connection.js";
import { AcpDriver } from "../src/acp/driver.js";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}
const bin = process.env.AGY_BIN || "agy";
console.log(`[probe] bin: ${bin}`);

const RAW = "probe-logs/acp-usage-traffic.jsonl";
fs.mkdirSync("probe-logs", { recursive: true });
const raw = fs.createWriteStream(RAW, { flags: "w" });
const logFrame = (dir, obj) => raw.write(JSON.stringify({ dir, at: new Date().toISOString(), ...obj }) + "\n");

const conn = new AcpConnection({
	bin,
	binArgs: ["acp"],
	cwd: fs.mkdtempSync(path.join(os.tmpdir(), "acp-usage-probe-")),
	log: () => {},
	permissions: () => "auto",
	onUpdate: (sessionId, update) => logFrame("update", { sessionId, update }),
	onExit: (info) => logFrame("exit", { ...info }),
});

const PROMPT =
	"Use the run_command tool to run exactly: echo acp-usage-probe. " +
	"After the tool finishes, reply with just: ok";

try {
	await conn.start();
	const session = await conn.newSession(process.cwd());
	console.log(`[probe] session: ${session.sessionId}`);
	const result = await conn.prompt(
		session.sessionId,
		PROMPT,
		[],
	);
	logFrame("result", { stopReason: result.stopReason, usage: result.usage ?? null });
	console.log(`[probe] stopReason: ${result.stopReason}`);
	console.log(`[probe] PromptResponse.usage: ${JSON.stringify(result.usage ?? null)}`);
	conn.kill();
	raw.end();

	if (process.env.AGY_PROBE_DRIVER_ONLY === "1") {
		await driverPass();
	} else {
		calibrate(session.sessionId, result.usage);
		await driverPass();
	}
} catch (err) {
	console.error(`[probe] failed: ${err instanceof Error ? err.message : String(err)}`);
	conn.kill();
	raw.end();
	process.exit(1);
}

function calibrate(sessionId, responseUsage) {
	const frames = fs
		.readFileSync(RAW, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l));
	const updates = frames
		.filter((f) => f.dir === "update" && f.update?.sessionUpdate === "usage_update")
		.map((f) => f.update);
	const used = updates.map((u) => u.used).filter((n) => typeof n === "number" && n > 0);
	console.log("\n[calibrate] usage_update frames:");
	for (const u of updates) console.log(`  used=${u.used} size=${u.size ?? "?"}`);

	// Per-step truth from the brain transcript (same conversation).
	const brain = path.join(
		os.homedir(),
		".gemini",
		"antigravity-cli",
		"brain",
		sessionId,
		".system_generated",
		"logs",
		"transcript_full.jsonl",
	);
	let steps = [];
	if (fs.existsSync(brain)) {
		steps = fs
			.readFileSync(brain, "utf8")
			.split("\n")
			.filter((l) => l.includes("PLANNER_RESPONSE"))
			.map((l) => JSON.parse(l))
			.map((e) => ({
				input: e.input_tokens ?? 0,
				cacheRead: e.cache_read_tokens ?? 0,
				output: e.output_tokens ?? 0,
			}));
	} else {
		console.log(`[calibrate] no brain transcript at ${brain}`);
	}

	console.log("\n[calibrate] per-step (brain PLANNER_RESPONSE):");
	let sum = { input: 0, cacheRead: 0, output: 0 };
	for (const [i, s] of steps.entries()) {
		console.log(`  step ${i + 1}: input=${s.input} cacheRead=${s.cacheRead} output=${s.output} ctx=${s.input + s.cacheRead + s.output}`);
		sum.input += s.input;
		sum.cacheRead += s.cacheRead;
		sum.output += s.output;
	}
	if (steps.length === 0) return;

	const trueLast = steps.at(-1);
	const trueLastCtx = trueLast.input + trueLast.cacheRead + trueLast.output;
	console.log("\n[calibrate] sums vs PromptResponse:");
	console.log(`  sum(steps):    ${JSON.stringify(sum)} total=${sum.input + sum.cacheRead + sum.output}`);
	console.log(`  PromptResponse: ${JSON.stringify(responseUsage ?? {})}`);
	console.log(`  inferences: usage_update=${used.length} brain_steps=${steps.length}`);
	console.log("\n[calibrate] occupancy hypothesis:");
	console.log(`  final used:            ${used.at(-1) ?? "?"}`);
	console.log(`  last step true ctx:    ${trueLastCtx}`);
	const delta = (used.at(-1) ?? 0) - trueLastCtx;
	console.log(`  used - trueCtx:        ${delta}`);
	console.log(`  last step cacheRead:   ${trueLast.cacheRead}`);
	console.log(
		delta === trueLast.cacheRead
			? "  => used overcounts by exactly the last cacheRead (double-count CONFIRMED)"
			: delta === 0
				? "  => used IS the true context (no double-count on this build)"
				: "  => neither hypothesis fits; inspect frames manually",
	);
}

/** Phase 2: run the REAL driver (correction included) against live agy and
 *  print what would land on pi's gauge. One extra tiny prompt. */
async function driverPass() {
	const driver = new AcpDriver({ bin, binArgs: ["acp"], log: () => {} });
	const handle = await driver.run({
		cwd: process.cwd(),
		model: "gemini-3.8-flash",
		effort: "low",
		mode: "accept-edits",
		skipPermissions: true,
		conversationId: null,
		prompt: PROMPT,
		timeoutMin: 3,
	});
	const activities = [];
	const collecting = (async () => {
		for (;;) {
			const a = await handle.next();
			if (a === null) return;
			activities.push(a);
		}
	})();
	const outcome = await handle.outcome;
	await collecting;
	console.log("\n[driver] outcome:", outcome.status, outcome.error ?? "");
	console.log("[driver] outcome.usage:", JSON.stringify(outcome.usage ?? null));
	console.log(
		"[driver] usage activities:",
		JSON.stringify(activities.filter((a) => a.type === "usage").map((a) => a.usage)),
	);
	await driver.close("shutdown");
}
