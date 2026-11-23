import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, test } from "vitest";
import { approvalHookScriptPath, __resetRealmForTests, bridgeRealm, type BridgeStreamSimple } from "../src/runtime.js";
import { bridgeMcpConfigDir, startMcpServer, TOKEN_HEADER, type McpBridgeDeps } from "../src/mcp-server.js";

const tmpDirs: string[] = [];
const prevEnv: Record<string, string | undefined> = {};

function withTmpAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-realm-test-"));
	tmpDirs.push(dir);
	if (!("PI_CODING_AGENT_DIR" in prevEnv)) {
		prevEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	}
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
	return dir;
}

afterEach(async () => {
	await __resetRealmForTests();
	for (const [k, v] of Object.entries(prevEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const k of Object.keys(prevEnv)) delete prevEnv[k];
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const dummyModel = {
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "agy-bridge",
	provider: "antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8192,
} as unknown as Model<Api>;

function makeStream(label: string): BridgeStreamSimple {
	return () => {
		const s = createAssistantMessageEventStream();
		s.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text: label }],
				api: "agy-bridge",
				provider: "antigravity",
				model: "gemini-3-flash",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
		s.end();
		return s;
	};
}

function makeDeps(toolName: string): McpBridgeDeps {
	return {
		listTools: () => [{ name: toolName, description: toolName, inputSchema: { type: "object", properties: {} } }],
		onToolCall: async (_callId, name) => ({ content: [{ type: "text", text: `${toolName}:${name}` }], isError: false }),
	};
}

async function mcpListTools(port: number, token: string): Promise<{ status: number; tools: string[] }> {
	const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			[TOKEN_HEADER]: token,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
	});
	if (!res.ok) return { status: res.status, tools: [] };
	const text = await res.text();
	const jsonLine = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? text;
	const parsed = JSON.parse(jsonLine) as { result?: { tools?: Array<{ name: string }> } };
	return { status: res.status, tools: (parsed.result?.tools ?? []).map((t) => t.name) };
}

test("startMcpServer addRoute serves independent surfaces and addDirConfig: false skips mcp_config.json", async () => {
	withTmpAgentDir();
	const r = await startMcpServer(makeDeps("tool_main"), { addDirConfig: false });
	assert.equal(r.ok, true);
	assert.ok(r.handle);
	assert.equal(fs.existsSync(path.join(bridgeMcpConfigDir(), ".agents", "mcp_config.json")), false);

	const route2 = r.handle.addRoute(makeDeps("tool_child"));
	assert.notEqual(route2.token, r.handle.token);

	const res1 = await mcpListTools(r.handle.port, r.handle.token);
	const res2 = await mcpListTools(r.handle.port, route2.token);
	assert.deepEqual(res1, { status: 200, tools: ["tool_main"] });
	assert.deepEqual(res2, { status: 200, tools: ["tool_child"] });

	route2.remove();
	const revoked = await mcpListTools(r.handle.port, route2.token);
	assert.equal(revoked.status, 403);
	const stillAlive = await mcpListTools(r.handle.port, r.handle.token);
	assert.deepEqual(stillAlive, { status: 200, tools: ["tool_main"] });

	await r.handle.close();
});

test("bridgeRealm shares one store, routes streamSimple by sessionId, and tears down only on last leave", async () => {
	withTmpAgentDir();
	const realm = bridgeRealm();
	assert.equal(realm.store, bridgeRealm().store);

	let s1Active = false;
	let s2Active = false;
	const s1 = realm.join({
		sessionId: () => "sess-1",
		streamSimple: makeStream("from-1"),
		hasActiveTurn: () => s1Active,
		conversationId: () => "conv-1",
	});
	const s2 = realm.join({
		sessionId: () => "sess-2",
		streamSimple: makeStream("from-2"),
		hasActiveTurn: () => s2Active,
		conversationId: () => "conv-2",
	});

	// streamSimple routes by options.sessionId, falling back to first/main when absent.
	const out1 = await realm.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext, { sessionId: "sess-1" } as never).result();
	const out2 = await realm.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext, { sessionId: "sess-2" } as never).result();
	const outFallback = await realm.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext).result();
	assert.equal((out1.content[0] as { text: string }).text, "from-1");
	assert.equal((out2.content[0] as { text: string }).text, "from-2");
	assert.equal((outFallback.content[0] as { text: string }).text, "from-1");

	// Attach bridges: first gets first=true, second gets first=false, distinct route tokens, shared realmToken.
	const a1 = await s1.attachBridge(makeDeps("t1"), () => {});
	const a2 = await s2.attachBridge(makeDeps("t2"), () => {});
	assert.equal(a1.ok, true);
	assert.equal(a1.first, true);
	assert.equal(a2.ok, true);
	assert.equal(a2.first, false);
	assert.ok(a1.handle && a2.handle);
	assert.equal(a1.handle.port, a2.handle.port);
	assert.equal(a1.handle.realmToken, a2.handle.realmToken);
	assert.notEqual(a1.handle.token, a2.handle.token);

	// Simulate per-realm artifacts (hook script + bridge dir).
	const hookScript = approvalHookScriptPath();
	fs.mkdirSync(path.dirname(hookScript), { recursive: true });
	fs.writeFileSync(hookScript, "// hook");
	fs.mkdirSync(bridgeMcpConfigDir(), { recursive: true });

	// Realm token routes to whichever session has an active turn; refuses when both are streaming.
	s1Active = true;
	assert.deepEqual(await mcpListTools(a1.handle.port, a1.handle.realmToken), { status: 200, tools: ["t1"] });
	s2Active = true;
	assert.deepEqual(await mcpListTools(a1.handle.port, a1.handle.realmToken), { status: 200, tools: [] });
	s1Active = false;
	s2Active = false;

	// Child leaves: child route revoked, parent route + per-realm artifacts survive.
	await s2.leave();
	assert.equal((await mcpListTools(a1.handle.port, a2.handle.token)).status, 403);
	assert.deepEqual(await mcpListTools(a1.handle.port, a1.handle.token), { status: 200, tools: ["t1"] });
	assert.equal(fs.existsSync(hookScript), true);
	assert.equal(fs.existsSync(bridgeMcpConfigDir()), true);

	// Last session leaves: listener closes and per-realm artifacts are removed.
	await s1.leave();
	assert.equal(fs.existsSync(hookScript), false);
	assert.equal(fs.existsSync(bridgeMcpConfigDir()), false);

	// No members left: streamSimple returns an error stream.
	const noSession = await realm.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext).result();
	assert.equal(noSession.stopReason, "error");
});
