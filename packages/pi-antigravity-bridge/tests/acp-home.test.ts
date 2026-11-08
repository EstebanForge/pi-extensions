import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { acpHomeStagingDir, removeStagedAcpHome, stageAcpHome, sweepStaleAcpHomes } from "../src/acp/home.js";
import { sweepStaleBridgeDirs } from "../src/mcp-server.js";

const fixtureRoots: string[] = [];
afterEach(() => {
	for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-home-test-"));
	fixtureRoots.push(root);
	const geminiHome = path.join(root, ".gemini");
	fs.mkdirSync(path.join(geminiHome, "config"), { recursive: true });
	fs.mkdirSync(path.join(geminiHome, "antigravity-cli"), { recursive: true });
	fs.writeFileSync(path.join(geminiHome, "antigravity-cli", "settings.json"), '{"queuedMessages":"send-immediately"}\n');
	fs.writeFileSync(path.join(geminiHome, "GEMINI.md"), "shared instructions\n");
	return { root, geminiHome, parentDir: path.join(root, "staging") };
}

test("ACP home preserves shared state but filters every bridge registration from MCP", () => {
	const { geminiHome, parentDir } = fixture();
	fs.writeFileSync(path.join(geminiHome, "config", "mcp_config.json"), JSON.stringify({
		mcpServers: {
			"pi-bridge": { serverUrl: "http://127.0.0.1:1/mcp" },
			"pi-bridge-123": { serverUrl: "http://127.0.0.1:2/mcp" },
			foreign: { serverUrl: "https://example.test/mcp", headers: { authorization: "secret" } },
		},
	}));
	const staged = stageAcpHome({ geminiHome, parentDir });
	const config = JSON.parse(fs.readFileSync(path.join(staged, "config", "mcp_config.json"), "utf8"));
	assert.deepEqual(Object.keys(config.mcpServers), ["foreign"]);
	assert.equal(config.mcpServers.foreign.headers.authorization, "secret");
	assert.equal(fs.readFileSync(path.join(staged, "antigravity-cli", "settings.json"), "utf8"), '{"queuedMessages":"send-immediately"}\n');
	assert.equal(fs.readFileSync(path.join(staged, "GEMINI.md"), "utf8"), "shared instructions\n");
	assert.equal(fs.statSync(path.join(staged, "config", "mcp_config.json")).mode & 0o777, 0o600);

	removeStagedAcpHome(staged);
	assert.equal(fs.existsSync(staged), false);
	assert.equal(fs.readFileSync(path.join(geminiHome, "antigravity-cli", "settings.json"), "utf8"), '{"queuedMessages":"send-immediately"}\n');
});

test("ACP home preserves dotfile-managed config symlinks", () => {
	const { root, geminiHome, parentDir } = fixture();
	const agents = path.join(root, "managed-agents");
	fs.mkdirSync(agents);
	fs.writeFileSync(path.join(agents, "agent.md"), "shared agent");
	fs.symlinkSync(agents, path.join(geminiHome, "config", "agents"));
	const staged = stageAcpHome({ geminiHome, parentDir });
	assert.equal(fs.readFileSync(path.join(staged, "config", "agents", "agent.md"), "utf8"), "shared agent");
	removeStagedAcpHome(staged);
});

test("ACP home skips dangling config symlinks", () => {
	const { root, geminiHome, parentDir } = fixture();
	fs.symlinkSync(path.join(root, "missing-target"), path.join(geminiHome, "config", "agents"));
	const staged = stageAcpHome({ geminiHome, parentDir });
	assert.equal(fs.existsSync(path.join(staged, "config", "agents")), false);
	assert.ok(fs.existsSync(path.join(staged, "antigravity-cli", "settings.json")));
	removeStagedAcpHome(staged);
});

test("stale staging dirs are swept even when no MCP server starts", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-home-sweep-"));
	try {
		const stale = path.join(root, "agy-mcp-4194303", "acp-home-stale");
		const live = path.join(root, `agy-mcp-${process.pid}`, "acp-home-live");
		fs.mkdirSync(stale, { recursive: true });
		fs.mkdirSync(live, { recursive: true });
		sweepStaleBridgeDirs(root, (pid) => pid === process.pid);
		assert.equal(fs.existsSync(stale), false);
		assert.equal(fs.existsSync(live), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("native staging is independent from MCP server teardown", () => {
	assert.equal(path.basename(acpHomeStagingDir()), "acp-homes");
	assert.equal(acpHomeStagingDir().includes(`agy-mcp-${process.pid}`), false);
});

test("stale native homes are swept by owning pid", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-home-pid-sweep-"));
	try {
		const stale = path.join(root, "acp-home-4194303-stale");
		const live = path.join(root, `acp-home-${process.pid}-live`);
		fs.mkdirSync(stale);
		fs.mkdirSync(live);
		sweepStaleAcpHomes(root, (pid) => pid === process.pid);
		assert.equal(fs.existsSync(stale), false);
		assert.equal(fs.existsSync(live), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("ACP home fails closed instead of inheriting an unreadable MCP config", () => {
	const { geminiHome, parentDir } = fixture();
	fs.writeFileSync(path.join(geminiHome, "config", "mcp_config.json"), "not json");
	assert.throws(() => stageAcpHome({ geminiHome, parentDir }), /mcp_config\.json/);
	assert.deepEqual(fs.existsSync(parentDir) ? fs.readdirSync(parentDir) : [], []);
});
