// Direct execution tests for generated hook script (Issue #5 regression).
// Verifies that the generated script always emits a valid JSON object on stdout,
// never a bare string scalar like "deny" or "allow".
//
// Run: npm test

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { hookScriptSource } from "../src/approval-hook.js";

let server: http.Server | null = null;

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = null;
	}
});

async function runHookScript(
	scriptContent: string,
	stdinText: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-exec-"));
	const scriptFile = path.join(tmpDir, "hook.js");
	fs.writeFileSync(scriptFile, scriptContent, { mode: 0o700 });
	try {
		const proc = spawn("node", [scriptFile], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		proc.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		proc.stdin?.write(stdinText);
		proc.stdin?.end();
		const code = await new Promise<number | null>((resolve) => {
			proc.on("close", resolve);
		});
		return { stdout, stderr, code };
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

function startStubServer(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<number> {
	return new Promise((resolve) => {
		server = http.createServer(handler);
		server.listen(0, "127.0.0.1", () => {
			const addr = server!.address();
			resolve(typeof addr === "object" && addr ? addr.port : 0);
		});
	});
}

const stdinPayload = JSON.stringify({
	toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
	stepIdx: 1,
	conversationId: "conv-1",
});

test("hook execution: direct terminal deny from POST emits valid JSON object", async () => {
	const port = await startStubServer((req, res) => {
		if (req.method === "POST" && req.url === "/approval") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ decision: "deny", reason: "tool not in matcher set" }));
			return;
		}
		res.writeHead(404).end();
	});

	const script = hookScriptSource({ port, token: "test-token", deadlineMs: 5000 });
	const { stdout, code } = await runHookScript(script, stdinPayload);

	assert.equal(code, 0);
	const parsed = JSON.parse(stdout.trim());
	assert.equal(typeof parsed, "object");
	assert.ok(parsed !== null && !Array.isArray(parsed));
	assert.equal(parsed.decision, "deny");
	assert.equal(parsed.reason, "tool not in matcher set");
	// Crucial: stdout must not be a JSON string literal like '"deny"'
	assert.notEqual(stdout.trim(), '"deny"');
});

test("hook execution: pending ticket followed by terminal deny from polling emits valid JSON object", async () => {
	let pollCount = 0;
	const port = await startStubServer((req, res) => {
		if (req.method === "POST" && req.url === "/approval") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ticket: "ticket-deny-123" }));
			return;
		}
		if (req.method === "GET" && req.url === "/approval/ticket-deny-123") {
			pollCount += 1;
			res.writeHead(200, { "content-type": "application/json" });
			if (pollCount === 1) {
				res.end(JSON.stringify({ status: "pending" }));
			} else {
				res.end(JSON.stringify({ decision: "deny", reason: "no active antigravity turn" }));
			}
			return;
		}
		res.writeHead(404).end();
	});

	const script = hookScriptSource({ port, token: "test-token", deadlineMs: 5000 });
	const { stdout, code } = await runHookScript(script, stdinPayload);

	assert.equal(code, 0);
	const parsed = JSON.parse(stdout.trim());
	assert.equal(typeof parsed, "object");
	assert.ok(parsed !== null && !Array.isArray(parsed));
	assert.equal(parsed.decision, "deny");
	assert.equal(parsed.reason, "no active antigravity turn");
	assert.notEqual(stdout.trim(), '"deny"');
});

test("hook execution: pending ticket followed by terminal allow from polling emits valid JSON object", async () => {
	const port = await startStubServer((req, res) => {
		if (req.method === "POST" && req.url === "/approval") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ticket: "ticket-allow-123" }));
			return;
		}
		if (req.method === "GET" && req.url === "/approval/ticket-allow-123") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ decision: "allow" }));
			return;
		}
		res.writeHead(404).end();
	});

	const script = hookScriptSource({ port, token: "test-token", deadlineMs: 5000 });
	const { stdout, code } = await runHookScript(script, stdinPayload);

	assert.equal(code, 0);
	const parsed = JSON.parse(stdout.trim());
	assert.equal(typeof parsed, "object");
	assert.ok(parsed !== null && !Array.isArray(parsed));
	assert.equal(parsed.decision, "allow");
	assert.notEqual(stdout.trim(), '"allow"');
});

test("hook execution: 404 unknown ticket during polling falls back to fail-closed object", async () => {
	const port = await startStubServer((req, res) => {
		if (req.method === "POST" && req.url === "/approval") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ticket: "ticket-404" }));
			return;
		}
		if (req.method === "GET" && req.url === "/approval/ticket-404") {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "unknown ticket" }));
			return;
		}
		res.writeHead(404).end();
	});

	const script = hookScriptSource({ port, token: "test-token", deadlineMs: 5000 });
	const { stdout, code } = await runHookScript(script, stdinPayload);

	assert.equal(code, 0);
	const parsed = JSON.parse(stdout.trim());
	assert.equal(typeof parsed, "object");
	assert.equal(parsed.decision, "deny");
	assert.equal(parsed.reason, "gate returned no decision");
});

test("hook execution: unreachable bridge emits fail-closed object", async () => {
	// Pick an inactive port by binding and immediately closing
	const deadPort = await startStubServer((_req, res) => res.end());
	await new Promise<void>((resolve) => server!.close(() => resolve()));
	server = null;

	const script = hookScriptSource({ port: deadPort, token: "test-token", deadlineMs: 5000 });
	const { stdout, code } = await runHookScript(script, stdinPayload);

	assert.equal(code, 0);
	const parsed = JSON.parse(stdout.trim());
	assert.equal(typeof parsed, "object");
	assert.equal(parsed.decision, "deny");
	assert.match(parsed.reason, /unreachable/);
});

test("hook execution: malformed POST body falls back to fail-closed object", async () => {
	const port = await startStubServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end("<html>not json</html>");
	});

	const script = hookScriptSource({ port, token: "test-token", deadlineMs: 5000 });
	const { stdout, code } = await runHookScript(script, stdinPayload);

	assert.equal(code, 0);
	const parsed = JSON.parse(stdout.trim());
	assert.equal(typeof parsed, "object");
	assert.ok(parsed !== null && !Array.isArray(parsed));
	assert.equal(parsed.decision, "deny");
});

test("hook execution: deadline with perpetually pending ticket emits fail-closed object", async () => {
	const port = await startStubServer((req, res) => {
		if (req.method === "POST" && req.url === "/approval") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ticket: "ticket-never" }));
			return;
		}
		if (req.method === "GET" && req.url === "/approval/ticket-never") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "pending" }));
			return;
		}
		res.writeHead(404).end();
	});

	// 700ms: generous headroom for the initial POST (asserting the exact
	// deadline reason requires the POST to complete inside the window) while
	// the 500ms poll sleep still forces loop exit well under a second.
	const script = hookScriptSource({ port, token: "test-token", deadlineMs: 700 });
	const { stdout, code } = await runHookScript(script, stdinPayload);

	assert.equal(code, 0);
	const parsed = JSON.parse(stdout.trim());
	assert.equal(typeof parsed, "object");
	assert.ok(parsed !== null && !Array.isArray(parsed));
	assert.equal(parsed.decision, "deny");
	assert.equal(parsed.reason, "approval gate deadline exceeded");
});
