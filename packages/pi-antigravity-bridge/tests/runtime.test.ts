import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, test, vi } from "vitest";
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

async function mcpCallTool(port: number, token: string, name: string): Promise<{ status: number; text?: string; isError?: boolean }> {
	const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			[TOKEN_HEADER]: token,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } }),
	});
	if (!res.ok) return { status: res.status };
	const raw = await res.text();
	const jsonLine = raw.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? raw;
	const parsed = JSON.parse(jsonLine) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
	return {
		status: res.status,
		text: parsed.result?.content?.[0]?.text,
		isError: parsed.result?.isError,
	};
}

async function mcpPostApproval(port: number, token: string, conversationId?: string): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`http://127.0.0.1:${port}/approval`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[TOKEN_HEADER]: token,
		},
		body: JSON.stringify({
			toolCall: { name: "run_command", args: { CommandLine: "echo hi" } },
			...(conversationId !== undefined ? { conversationId } : {}),
		}),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
	// Single member: absent sessionId falls back to sole member.
	const soleOut = await realm.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext).result();
	assert.equal((soleOut.content[0] as { text: string }).text, "from-1");

	const s2 = realm.join({
		sessionId: () => "sess-2",
		streamSimple: makeStream("from-2"),
		hasActiveTurn: () => s2Active,
		conversationId: () => "conv-2",
	});

	// Multiple members: routes by exact sessionId or `${id}:` prefix; absent/unmatched fails closed.
	const out1 = await realm.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext, { sessionId: "sess-1" } as never).result();
	const out2 = await realm.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext, { sessionId: "sess-2" } as never).result();
	const outPrefix = await realm.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext, { sessionId: "sess-2:sub" } as never).result();
	const outMissing = await realm.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext).result();
	const outUnknown = await realm.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext, { sessionId: "sess-unknown" } as never).result();
	assert.equal((out1.content[0] as { text: string }).text, "from-1");
	assert.equal((out2.content[0] as { text: string }).text, "from-2");
	assert.equal((outPrefix.content[0] as { text: string }).text, "from-2");
	assert.equal(outMissing.stopReason, "error");
	assert.equal(outUnknown.stopReason, "error");

	// Attach bridges: first gets first=true, second gets first=false, distinct route tokens, shared realmToken, no raw addRoute.
	const a1 = await s1.attachBridge(makeDeps("t1"), () => {});
	const a2 = await s2.attachBridge(makeDeps("t2"), () => {});
	assert.equal(a1.ok, true);
	assert.equal(a1.first, true);
	assert.equal(a2.ok, true);
	assert.equal(a2.first, false);
	assert.ok(a1.handle && a2.handle);
	assert.equal("addRoute" in a1.handle, false);
	assert.equal(a1.handle.port, a2.handle.port);
	assert.equal(a1.handle.realmToken, a2.handle.realmToken);
	assert.notEqual(a1.handle.token, a2.handle.token);

	// Route tokens isolate tools/call even when neither or both turns are active.
	assert.deepEqual(await mcpCallTool(a1.handle.port, a1.handle.token, "t1"), { status: 200, text: "t1:t1", isError: false });
	assert.deepEqual(await mcpCallTool(a2.handle.port, a2.handle.token, "t2"), { status: 200, text: "t2:t2", isError: false });

	// Simulate per-realm artifacts (hook script + bridge dir).
	const hookScript = approvalHookScriptPath();
	fs.mkdirSync(path.dirname(hookScript), { recursive: true });
	fs.writeFileSync(hookScript, "// hook");
	fs.mkdirSync(bridgeMcpConfigDir(), { recursive: true });

	// Realm token routes to whichever session has an active turn; refuses when both are streaming.
	s1Active = true;
	assert.deepEqual(await mcpListTools(a1.handle.port, a1.handle.realmToken), { status: 200, tools: ["t1"] });
	assert.deepEqual(await mcpCallTool(a1.handle.port, a1.handle.realmToken, "t1"), { status: 200, text: "t1:t1", isError: false });
	s2Active = true;
	assert.deepEqual(await mcpListTools(a1.handle.port, a1.handle.realmToken), { status: 200, tools: [] });
	const ambiguousCall = await mcpCallTool(a1.handle.port, a1.handle.realmToken, "t1");
	assert.equal(ambiguousCall.isError, true);
	s1Active = false;
	s2Active = false;

	// Child leaves (twice: idempotent): child route revoked, parent route + per-realm artifacts survive.
	await s2.leave();
	await s2.leave();
	assert.equal((await mcpListTools(a1.handle.port, a2.handle.token)).status, 403);
	assert.deepEqual(await mcpListTools(a1.handle.port, a1.handle.token), { status: 200, tools: ["t1"] });
	assert.equal(fs.existsSync(hookScript), true);
	assert.equal(fs.existsSync(bridgeMcpConfigDir()), true);

	// Last session leaves: listener closes and per-realm artifacts are removed.
	await s1.leave();
	assert.equal(fs.existsSync(hookScript), false);
	assert.equal(fs.existsSync(bridgeMcpConfigDir()), false);

	// Port is closed after last leave; re-joining starts a fresh listener cleanly.
	await assert.rejects(() => mcpListTools(a1.handle!.port, a1.handle!.token));
	const s3 = realm.join({
		sessionId: () => "sess-3",
		streamSimple: makeStream("from-3"),
		hasActiveTurn: () => false,
		conversationId: () => undefined,
	});
	const a3 = await s3.attachBridge(makeDeps("t3"), () => {});
	assert.equal(a3.ok, true);
	assert.equal(a3.first, true);
	assert.ok(a3.handle);
	assert.deepEqual(await mcpListTools(a3.handle.port, a3.handle.token), { status: 200, tools: ["t3"] });
	await s3.leave();

	// No members left: streamSimple returns an error stream.
	const noSession = await realm.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext).result();
	assert.equal(noSession.stopReason, "error");
});

test("bridgeRealm survives module reload with live member, prefers newest duplicate sessionId, and isolates log errors", async () => {
	withTmpAgentDir();
	const realm1 = bridgeRealm();
	let logCallsAfterLeave = 0;
	let active = false;
	const seenApprovals: string[] = [];

	const sOld = realm1.join({
		sessionId: () => "dup-sess",
		streamSimple: makeStream("from-old"),
		hasActiveTurn: () => active,
		conversationId: () => "conv-old",
	});
	await sOld.attachBridge(
		{
			...makeDeps("t-old"),
			onApproval: (ticket) => {
				seenApprovals.push(`old:${ticket}`);
			},
		},
		() => {
			logCallsAfterLeave++;
			throw new Error("dead ctx");
		},
	);

	// Simulate /reload re-importing runtime.ts with a fresh Realm class.
	vi.resetModules();
	const reloaded = await import("../src/runtime.js");
	const realm2 = reloaded.bridgeRealm();
	assert.equal(realm2, realm1);

	const sNew = realm2.join({
		sessionId: () => "dup-sess",
		streamSimple: makeStream("from-new"),
		hasActiveTurn: () => true,
		conversationId: () => "conv-new",
	});
	const aNew = await sNew.attachBridge(
		{
			...makeDeps("t-new"),
			onApproval: (ticket) => {
				seenApprovals.push(`new:${ticket}`);
			},
		},
		() => {
			throw new Error("throwing sink");
		},
	);
	assert.equal(aNew.ok, true);
	assert.ok(aNew.handle);

	// Duplicate sessionId routes to the newest member.
	const dupOut = await realm2.streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext, { sessionId: "dup-sess" } as never).result();
	assert.equal((dupOut.content[0] as { text: string }).text, "from-new");

	// Throwing log sink must not turn 403 unauthorized into 500.
	const unauth = await mcpListTools(aNew.handle.port, "wrong-token");
	assert.equal(unauth.status, 403);

	// After sOld leaves, its log sink must never be called again.
	await sOld.leave();
	logCallsAfterLeave = 0;
	await mcpListTools(aNew.handle.port, "wrong-token");
	assert.equal(logCallsAfterLeave, 0);

	// Realm-token approval routes by conversationId when multiple turns are active, and denies when unknown.
	const sOther = realm2.join({
		sessionId: () => "other-sess",
		streamSimple: makeStream("from-other"),
		hasActiveTurn: () => true,
		conversationId: () => "conv-other",
	});
	await sOther.attachBridge(
		{
			...makeDeps("t-other"),
			onApproval: (ticket) => {
				seenApprovals.push(`other:${ticket}`);
			},
		},
		() => {},
	);

	const routedApproval = await mcpPostApproval(aNew.handle.port, aNew.handle.realmToken, "conv-new");
	assert.equal(routedApproval.status, 200);
	assert.ok(typeof routedApproval.body.ticket === "string");
	assert.equal(seenApprovals.length, 1);
	assert.ok(seenApprovals[0].startsWith("new:"));

	const ambiguousApproval = await mcpPostApproval(aNew.handle.port, aNew.handle.realmToken, "conv-missing");
	assert.equal(ambiguousApproval.status, 200);
	assert.ok(typeof ambiguousApproval.body.ticket === "string");
	const poll = await fetch(`http://127.0.0.1:${aNew.handle.port}/approval/${ambiguousApproval.body.ticket as string}`, {
		headers: { [TOKEN_HEADER]: aNew.handle.realmToken },
	});
	const decision = (await poll.json()) as { decision?: string };
	assert.equal(decision.decision, "deny");

	await sOther.leave();
	await sNew.leave();
});
