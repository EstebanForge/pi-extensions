// Live codemode-over-MCP probe (AGY_ACP_LIVE=1; real agy, billed inference).
//
// Answers the codemode spike questions against agy 1.5.16 ACP:
//   1. Does agy call a single advertised MCP `codemode` tool (one tool in the
//      bridge catalog, no native-tool competition)?
//   2. Does the script execute host-side with its nested tool calls staying
//      OUT of agy's model context (one tools/call on the wire, N nested calls
//      in the sandbox)?
//   3. Does the MCP registration survive session/load on a FRESH agy process
//      (mcpServers is re-sent with session/load)?
//   4. What does a codemode turn cost versus a plain reply?
//
// The surface mirrors the real shape: pi exposes a `codemode` tool ({code});
// the bridge routes the call through pi, where the sandbox runs with pi's
// tools injected. Here the "pi side" is a CodemodeSandbox with two probe
// tools, so the transport is live while execution is deterministic.
//
// Run: AGY_ACP_LIVE=1 npx tsx scripts/probe-codemode.mjs

import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { AcpDriver } from "../src/acp/driver.js";
import { startMcpServer, TOKEN_HEADER } from "../src/mcp-server.js";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (this probe runs real, billed agy turns)");
	process.exit(1);
}

const MODEL = process.env.AGY_PROBE_MODEL || "gemini-4-hydrogen-medium";

const BASE = {
	cwd: process.cwd(),
	model: MODEL,
	effort: "low",
	mode: "accept-edits",
	skipPermissions: true,
	timeoutMin: 3,
};

// --- bridge: single codemode tool over MCP ----------------------------------

const mcpCalls = []; // one entry per tools/call agy made
const nestedCalls = []; // one entry per sandbox tools.* invocation

// One sandbox, reused across scripts (a worker spins up per execute()).
const sb = new CodemodeSandbox({
	timeoutMs: 30_000,
	tools: [
		{
			name: "add",
			description: "Add two numbers.",
			execute: async (args) => {
				nestedCalls.push({ tool: "add", args });
				return (args.a ?? 0) + (args.b ?? 0);
			},
		},
		{
			name: "echo",
			description: "Echo a short text back.",
			execute: async (args) => {
				nestedCalls.push({ tool: "echo", args });
				return String(args.text ?? "");
			},
		},
	],
});

const CODEMODE_DESCRIPTION = `Run a short JavaScript script in a sandbox and return its result. The script is the body of an async function (top-level await and return work).

Inside the script:
- await tools.add({ a, b }) adds two numbers.
- await tools.echo({ text }) echoes text.
- text(value) appends output; return value sets the script result.
- No imports, fetch, timers, or process access.

Example:
	const sum = await tools.add({ a: 2, b: 3 });
	await tools.echo({ text: "sum " + sum });
	return "done";`;

const bridge = await startMcpServer({
	listTools: () => [
		{
			name: "codemode",
			description: CODEMODE_DESCRIPTION,
			inputSchema: {
				type: "object",
				properties: { code: { type: "string", description: "Raw JavaScript source." } },
				required: ["code"],
			},
		},
	],
	onToolCall: async (_callId, name, args) => {
		mcpCalls.push({ name, hasCode: typeof args.code === "string", codeLen: typeof args.code === "string" ? args.code.length : 0 });
		if (name !== "codemode") {
			return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
		}
		const t0 = Date.now();
		const result = await sb.execute(String(args.code ?? ""));
		const ms = Date.now() - t0;
		const text = [result.output.map((o) => o.text ?? "").join("\n"), result.ok ? `result: ${JSON.stringify(result.value)}` : `error: ${result.error?.message ?? "unknown"}`]
			.filter(Boolean)
			.join("\n");
		return { content: [{ type: "text", text: `${text}\n(script ${ms}ms)` }], isError: !result.ok };
	},
});
if (!bridge.ok || !bridge.handle) {
	console.error(`bridge failed to start: ${bridge.reason}`);
	process.exit(1);
}
const mcpServers = () => [
	{
		name: "pi-bridge",
		type: "http",
		url: `http://127.0.0.1:${bridge.handle.port}/mcp`,
		headers: [{ name: TOKEN_HEADER, value: bridge.handle.token }],
	},
];

// --- turn runner -------------------------------------------------------------

async function runTurn(driver, request) {
	const t0 = Date.now();
	const deltas = [];
	const tools = [];
	const handle = await driver.run({ ...BASE, ...request, signal: new AbortController().signal });
	const collecting = (async () => {
		for (;;) {
			const activity = await handle.next();
			if (activity === null) return;
			if (activity.type === "text") deltas.push(activity.delta);
			else if (activity.type === "tool_start" || activity.type === "tool_done") tools.push(activity.name);
		}
	})();
	const outcome = await handle.outcome;
	await collecting.catch(() => {});
	return {
		status: outcome.status,
		text: deltas.join(""),
		tools,
		usage: outcome.usage ?? null,
		ms: Date.now() - t0,
	};
}

const results = [];
function check(name, pass, note) {
	results.push({ name, pass });
	console.log(`[probe] ${pass ? "PASS" : "FAIL"} ${name}${note ? ` — ${note}` : ""}`);
}

const TASK1 =
	"Use the codemode tool once: write a script that adds 2 and 3 with tools.add, echoes the word BRIDGE-CM with tools.echo, and returns the sum. Reply with just the returned value.";

const bin = process.env.AGY_BIN || "agy";
const makeDriver = () =>
	new AcpDriver({
		bin,
		binArgs: ["acp"],
		isolateHome: true,
		mcpServers,
		log: (msg, data) => {
			if (String(msg).includes("error") || String(msg).includes("fail")) console.error(`[acp] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`);
		},
	});

// --- 1. fresh session: does agy call codemode, and do nested calls stay off-wire

let conversationId = null;
{
	const driver = makeDriver();
	try {
		const t1 = await runTurn(driver, { prompt: TASK1 });
		check("turn1 OK", t1.status === "OK", `status=${t1.status} ms=${t1.ms}`);
		check("turn1 reply carries the returned sum", t1.text.includes("5"), t1.text.slice(0, 80));
		check("agy called the codemode tool exactly once", mcpCalls.length === 1 && mcpCalls[0]?.name === "codemode", JSON.stringify(mcpCalls));
		check(
			"nested tool calls executed in the sandbox, not on the wire",
			nestedCalls.some((c) => c.tool === "add" && c.args.a === 2 && c.args.b === 3) && nestedCalls.some((c) => c.tool === "echo" && c.args.text === "BRIDGE-CM"),
			JSON.stringify(nestedCalls),
		);
		const totalTokens = Number(t1.usage?.total_tokens ?? t1.usage?.totalTokens ?? 0);
		check("turn1 reported usage", totalTokens > 0, JSON.stringify(t1.usage));
		console.log(`[probe] codemode turn: ${t1.ms}ms usage=${JSON.stringify(t1.usage)}`);
	} finally {
		// snapshot before close: the driver owns the conversation id
		const snap = driver.snapshot?.();
		conversationId = snap?.conversationId ?? null;
		await driver.close("shutdown");
	}
}

// --- 2. session/load on a fresh process: MCP registration must survive -------

{
	const driver = makeDriver();
	try {
		const t2 = await runTurn(driver, { prompt: "Use the codemode tool: echo the word RELOADED-CM with tools.echo and return it. Reply with just that word.", conversationId });
		check("session/load turn OK on a fresh agy process", t2.status === "OK", `status=${t2.status} conv=${conversationId ?? "none"}`);
		check("loaded session still calls codemode", mcpCalls.length === 2, `mcpCalls=${mcpCalls.length}`);
		check("loaded-session script echoed RELOADED-CM", t2.text.includes("RELOADED-CM"), t2.text.slice(0, 80));
		// --- 3. cost baseline: plain reply, no tools ----------------------------
		const t3 = await runTurn(driver, { prompt: "Reply with the single word DONE and nothing else. Do not call any tool." });
		console.log(`[probe] plain turn: ${t3.ms}ms usage=${JSON.stringify(t3.usage)}`);
		check("baseline reply OK", t3.status === "OK", `status=${t3.status}`);
	} finally {
		await driver.close("shutdown");
	}
}

await sb.close();
await bridge.handle.close();

const pass = results.filter((r) => r.pass).length;
console.log(`\n[probe] ${pass}/${results.length} checks passed (model ${MODEL})`);
process.exit(pass === results.length ? 0 : 1);
