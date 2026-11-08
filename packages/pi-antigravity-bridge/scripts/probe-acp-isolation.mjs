// Live: AGY_ACP_LIVE=1 npx tsx scripts/probe-acp-isolation.mjs
// Registers one global bridge entry and proves ACP cannot inherit it.
import { AcpDriver } from "../src/acp/driver.ts";
import { registerBridgeServer, unregisterBridgeServer } from "../src/mcp-registration.ts";
import { startMcpServer, TOKEN_HEADER } from "../src/mcp-server.ts";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}

const inheritedCalls = [];
const inherited = await startMcpServer({
	listTools: () => [{
		name: "inherited_probe",
		description: "Return INHERITED-CALLED. Use when asked.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	}],
	onToolCall: async (_id, name) => {
		inheritedCalls.push(name);
		return { content: [{ type: "text", text: "INHERITED-CALLED" }], isError: false };
	},
}, { log: (msg, data) => console.error(`[inherited] ${msg}${data ? ` ${JSON.stringify(data)}` : ""}`) });
if (!inherited.ok || !inherited.handle) throw new Error(inherited.reason ?? "inherited bridge did not start");

const registration = registerBridgeServer({
	pid: process.pid,
	port: inherited.handle.port,
	token: inherited.handle.token,
	tokenHeader: TOKEN_HEADER,
});
if (!registration.wrote) throw new Error(registration.reason ?? "global registration failed");

const driver = new AcpDriver({
	bin: process.env.AGY_BIN || "agy",
	binArgs: ["acp"],
	isolateHome: true,
	log: (msg, data) => console.error(`[acp] ${msg}${data ? ` ${JSON.stringify(data)}` : ""}`),
});
try {
	const handle = await driver.run({
		cwd: process.cwd(),
		model: "gemini-3.8-flash",
		effort: "low",
		mode: "accept-edits",
		skipPermissions: true,
		timeoutMin: 2,
		prompt: "Call inherited_probe exactly once, then reply with its result. If that tool is unavailable, reply exactly ISOLATED. Do not use any other tool.",
	});
	let text = "";
	while (true) {
		const activity = await handle.next();
		if (!activity) break;
		if (activity.type === "text") text += activity.delta;
	}
	const outcome = await handle.outcome;
	const isolated = inheritedCalls.length === 0 && text.includes("ISOLATED");
	console.log(JSON.stringify({ outcome, text, inheritedCalls, isolated }, null, 2));
	if (!isolated) process.exitCode = 1;
} finally {
	await driver.close("shutdown");
	await inherited.handle.close();
	unregisterBridgeServer(process.pid);
}
