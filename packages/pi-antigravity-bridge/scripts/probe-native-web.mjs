// Live probe: can agy reach its NATIVE web tools (search_web, url_context, ...)
// inside our bridge sessions, on both engines? Gated per engine (spends quota):
//
//   AGY_LIVE=1 npx tsx scripts/probe-native-web.mjs stream
//   AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
//     npx tsx scripts/probe-native-web.mjs acp
//
// Neutrality: the stream-json run starts the bridge with an EMPTY catalog (agy's
// only MCP server exposes zero tools) and the ACP run passes no mcpServers at
// all. Any web tool the model uses is therefore agy-native, not announced by Pi.
//
// Verdict per engine:
//   PASS  = a web-ish native tool step was observed AND the answer is not the
//           NO-WEB-TOOL escape hatch.
//   HALLUCINATION = answer looks like a version but NO tool step was observed.
//   FAIL  = NO-WEB-TOOL answer or no web tool and no plausible answer.

import { mkdtempSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StreamDriver } from "../src/driver.js";
import { bridgeMcpConfigDir, startMcpServer } from "../src/mcp-server.js";
import { AcpDriver } from "../src/acp/driver.js";
import { resolveAcpBinary } from "../src/acp/connection.js";

const engine = process.argv[2] ?? "both";
const MODEL_STREAM = process.env.AGY_SMOKE_MODEL ?? "gemini-3.7-flash-medium";
const MODEL_ACP = process.env.AGY_SMOKE_MODEL_ACP ?? "gemini-3.7-flash";

const PROMPT =
	"Search the web for the current latest stable version of Node.js, then reply with ONLY the version number. " +
	"If you have no way to search the web, reply exactly: NO-WEB-TOOL";

const WEB_TOOL_RE = /search|web|url|fetch|browse/i;

mkdirSync("probe-logs", { recursive: true });
const logFor = (name) => {
	const file = `probe-logs/native-web-${name}.log`;
	return (obj) => appendFileSync(file, JSON.stringify(obj) + "\n");
};

function verdict(toolNames, answer) {
	const webCall = toolNames.filter((n) => WEB_TOOL_RE.test(n));
	const norm = answer.toUpperCase();
	if (webCall.length > 0 && !norm.includes("NO-WEB-TOOL")) {
		return { verdict: "PASS", detail: `native web tools fired: ${webCall.join(", ")}` };
	}
	if (webCall.length === 0 && norm.includes("NO-WEB-TOOL")) {
		return { verdict: "FAIL", detail: "model reports no web capability and used none" };
	}
	if (webCall.length === 0 && /\d+\.\d+\.\d+/.test(answer)) {
		return { verdict: "HALLUCINATION", detail: "version answered with NO web tool step observed" };
	}
	return { verdict: "FAIL", detail: `no web tool observed; tools seen: [${toolNames.join(", ")}]` };
}

async function probeStreamJson() {
	const log = logFor("stream-json");
	// Bridge with an EMPTY catalog: deterministic neutrality. agy's only MCP
	// server exposes zero tools, so every tool it uses is native.
	const bridge = await startMcpServer({ log: (msg, data) => log({ t: "bridge", msg, data }), listTools: () => [], onToolCall: async () => ({ content: [{ type: "text", text: "unreachable" }], isError: true }) });
	if (!bridge.ok || !bridge.handle) throw new Error(`bridge failed to start: ${bridge.reason}`);
	const WorkCwd = mkdtempSync(path.join(os.tmpdir(), "agy-native-web-probe-"));
	const driver = new StreamDriver();
	const toolNames = [];
	let answer = "";
	try {
		const handle = await driver.run({
			cwd: WorkCwd,
			model: MODEL_STREAM,
			mode: "accept-edits",
			skipPermissions: true,
			prompt: PROMPT,
			timeoutMin: 3,
			inactivityMin: 2,
		});
		for (;;) {
			const a = await handle.next();
			if (!a) break;
			log({ t: "activity", activity: a });
			if (a.type === "tool_start") {
				toolNames.push(a.name);
				console.log(`[stream] tool_start: ${a.name}`);
			}
			if (a.type === "tool_error") console.log(`[stream] tool_error: ${JSON.stringify(a).slice(0, 300)}`);
			if (a.type === "text") answer += a.delta;
		}
		const outcome = await handle.outcome;
		log({ t: "outcome", status: outcome.status, error: outcome.error ?? null });
		console.log(`[stream] outcome: ${outcome.status} answer: ${answer.trim() || "(none)"}`);
	} finally {
		await driver.close("shutdown");
		await bridge.handle.close();
		rmSync(WorkCwd, { recursive: true, force: true }); // self-created temp dir only
	}
	return verdict(toolNames, answer);
}

async function probeAcp() {
	const log = logFor("acp");
	const bin = resolveAcpBinary(process.env.AGY_ACP_BIN || "");
	const driver = new AcpDriver({ bin, log: (msg, data) => log({ t: "acp", msg, data }) });
	const toolNames = [];
	let answer = "";
	try {
		// No mcpServers: session/new carries no bridge. Every tool is native.
		const handle = await driver.run({
			cwd: process.cwd(),
			model: MODEL_ACP,
			effort: "low",
			mode: "accept-edits",
			skipPermissions: true,
			prompt: PROMPT,
			timeoutMin: 3,
		});
		for (;;) {
			const a = await handle.next();
			if (!a) break;
			log({ t: "activity", activity: a });
			if (a.type === "tool_start") {
				toolNames.push(a.name);
				console.log(`[acp] tool_start: ${a.name}`);
			}
			if (a.type === "tool_error") console.log(`[acp] tool_error: ${JSON.stringify(a).slice(0, 300)}`);
			if (a.type === "text") answer += a.delta;
		}
		const outcome = await handle.outcome;
		log({ t: "outcome", status: outcome.status, error: outcome.error ?? null });
		console.log(`[acp] outcome: ${outcome.status} answer: ${answer.trim() || "(none)"}`);
	} finally {
		await driver.close("shutdown");
	}
	return verdict(toolNames, answer);
}

const engines = engine === "both" ? ["stream-json", "acp"] : [engine === "acp" ? "acp" : "stream-json"];
const results = {};
for (const e of engines) {
	if (e === "stream-json" && process.env.AGY_LIVE !== "1") {
		console.log("[skip] stream-json: set AGY_LIVE=1");
		continue;
	}
	if (e === "acp" && process.env.AGY_ACP_LIVE !== "1") {
		console.log("[skip] acp: set AGY_ACP_LIVE=1");
		continue;
	}
	console.log(`\n=== probe ${e} ===`);
	results[e] = e === "stream-json" ? await probeStreamJson() : await probeAcp();
	console.log(`=== ${e}: ${results[e].verdict} (${results[e].detail}) ===`);
}

console.log("\n=== SUMMARY ===");
for (const [e, r] of Object.entries(results)) console.log(`${e}: ${r.verdict} - ${r.detail}`);
const all = Object.values(results);
if (all.length === 0) process.exit(1);
process.exit(all.every((r) => r.verdict === "PASS") ? 0 : 2);
