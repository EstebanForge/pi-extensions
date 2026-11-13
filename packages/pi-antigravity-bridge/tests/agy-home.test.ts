import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { agyHomeStagingDir, removeStagedAgyHome, stageAgyHome, sweepStagedAgyHomes } from "../src/acp/home.js";
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
	const staged = stageAgyHome({ geminiHome, parentDir });
	const config = JSON.parse(fs.readFileSync(path.join(staged, "config", "mcp_config.json"), "utf8"));
	assert.deepEqual(Object.keys(config.mcpServers), ["foreign"]);
	assert.equal(config.mcpServers.foreign.headers.authorization, "secret");
	assert.equal(fs.readFileSync(path.join(staged, "antigravity-cli", "settings.json"), "utf8"), '{"queuedMessages":"send-immediately"}\n');
	assert.equal(fs.readFileSync(path.join(staged, "GEMINI.md"), "utf8"), "shared instructions\n");
	assert.equal(fs.statSync(path.join(staged, "config", "mcp_config.json")).mode & 0o777, 0o600);

	removeStagedAgyHome(staged);
	assert.equal(fs.existsSync(staged), false);
	assert.equal(fs.readFileSync(path.join(geminiHome, "antigravity-cli", "settings.json"), "utf8"), '{"queuedMessages":"send-immediately"}\n');
});

test("ACP home preserves dotfile-managed config symlinks", () => {
	const { root, geminiHome, parentDir } = fixture();
	const agents = path.join(root, "managed-agents");
	fs.mkdirSync(agents);
	fs.writeFileSync(path.join(agents, "agent.md"), "shared agent");
	fs.symlinkSync(agents, path.join(geminiHome, "config", "agents"));
	const staged = stageAgyHome({ geminiHome, parentDir });
	assert.equal(fs.readFileSync(path.join(staged, "config", "agents", "agent.md"), "utf8"), "shared agent");
	removeStagedAgyHome(staged);
});

test("ACP home skips dangling config symlinks", () => {
	const { root, geminiHome, parentDir } = fixture();
	fs.symlinkSync(path.join(root, "missing-target"), path.join(geminiHome, "config", "agents"));
	const staged = stageAgyHome({ geminiHome, parentDir });
	assert.equal(fs.existsSync(path.join(staged, "config", "agents")), false);
	assert.ok(fs.existsSync(path.join(staged, "antigravity-cli", "settings.json")));
	removeStagedAgyHome(staged);
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
	assert.equal(path.basename(agyHomeStagingDir()), "acp-homes");
	assert.equal(agyHomeStagingDir().includes(`agy-mcp-${process.pid}`), false);
});

test("stale native homes are swept by owning pid", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-home-pid-sweep-"));
	try {
		const stale = path.join(root, "acp-home-4194303-stale");
		const live = path.join(root, `acp-home-${process.pid}-live`);
		fs.mkdirSync(stale);
		fs.mkdirSync(live);
		sweepStagedAgyHomes(root, (pid) => pid === process.pid);
		assert.equal(fs.existsSync(stale), false);
		assert.equal(fs.existsSync(live), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("ACP home fails closed instead of inheriting an unreadable MCP config", () => {
	const { geminiHome, parentDir } = fixture();
	fs.writeFileSync(path.join(geminiHome, "config", "mcp_config.json"), "not json");
	assert.throws(() => stageAgyHome({ geminiHome, parentDir }), /mcp_config\.json/);
	assert.deepEqual(fs.existsSync(parentDir) ? fs.readdirSync(parentDir) : [], []);
});

test("ACP home treats the CLI's empty MCP config as 'no config' (issue #11)", () => {
	const { geminiHome, parentDir } = fixture();
	for (const content of ["", "\n\t ", "\uFEFF"]) {
		fs.writeFileSync(path.join(geminiHome, "config", "mcp_config.json"), content);
		const staged = stageAgyHome({ geminiHome, parentDir });
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staged, "config", "mcp_config.json"), "utf8")), { mcpServers: {} });
		removeStagedAgyHome(staged);
	}
});

test("ACP home parses a BOM-prefixed MCP config (issue #11)", () => {
	const { geminiHome, parentDir } = fixture();
	fs.writeFileSync(path.join(geminiHome, "config", "mcp_config.json"), "\uFEFF{\"mcpServers\": {\"keep\": {\"command\": \"x\"}}}");
	const staged = stageAgyHome({ geminiHome, parentDir });
	const stagedConfig = JSON.parse(fs.readFileSync(path.join(staged, "config", "mcp_config.json"), "utf8")) as { mcpServers: Record<string, unknown> };
	assert.deepEqual(Object.keys(stagedConfig.mcpServers), ["keep"]);
});

test("ACP home fails closed on a malformed mcpServers value", () => {
	const { geminiHome, parentDir } = fixture();
	fs.writeFileSync(path.join(geminiHome, "config", "mcp_config.json"), JSON.stringify({ mcpServers: "oops" }));
	assert.throws(() => stageAgyHome({ geminiHome, parentDir }), /mcpServers/);
});

test("stream-json staging writes its own bridge ENABLED, foreign bridges filtered (issue #14)", () => {
	// The own entry must never ride the suppression marker: the marker hides
	// bridges from an agy reading the GLOBAL config, and a private-home agy
	// never reads global. Reusing registerBridgeServer here would land our own
	// entry disabled whenever any delegation is live anywhere, breaking G9
	// silently inside our own home.
	const { geminiHome, parentDir } = fixture();
	fs.writeFileSync(path.join(geminiHome, "config", "mcp_config.json"), JSON.stringify({
		mcpServers: {
			"pi-bridge-999": { serverUrl: "http://127.0.0.1:9/mcp" },
			foreign: { serverUrl: "https://example.test/mcp", headers: { authorization: "secret" } },
		},
	}));
	const staged = stageAgyHome({
		geminiHome,
		parentDir,
		prefix: "agy-home",
		ownBridge: { pid: 4242, port: 4321, token: "tok", tokenHeader: "x-bridge-token" },
	});
	assert.equal(path.basename(staged).startsWith("agy-home-"), true);
	const config = JSON.parse(fs.readFileSync(path.join(staged, "config", "mcp_config.json"), "utf8")) as {
		mcpServers: Record<string, { disabled?: boolean; headers?: Record<string, string>; serverUrl?: string }>;
	};
	assert.deepEqual(Object.keys(config.mcpServers).sort(), ["foreign", "pi-bridge-4242"]);
	assert.equal(config.mcpServers["pi-bridge-4242"]?.disabled, false);
	assert.equal(config.mcpServers["pi-bridge-4242"]?.headers?.["x-bridge-token"], "tok");
	assert.equal(config.mcpServers["pi-bridge-4242"]?.serverUrl, "http://127.0.0.1:4321/mcp");
	removeStagedAgyHome(staged);
});

test("stream-json staging without a bridge handle stages foreign-filtered only", () => {
	const { geminiHome, parentDir } = fixture();
	fs.writeFileSync(path.join(geminiHome, "config", "mcp_config.json"), JSON.stringify({
		mcpServers: {
			"pi-bridge-777": { serverUrl: "http://127.0.0.1:7/mcp" },
			foreign: { serverUrl: "https://example.test/mcp" },
		},
	}));
	const staged = stageAgyHome({ geminiHome, parentDir, prefix: "agy-home" });
	const config = JSON.parse(fs.readFileSync(path.join(staged, "config", "mcp_config.json"), "utf8")) as {
		mcpServers: Record<string, unknown>;
	};
	assert.deepEqual(Object.keys(config.mcpServers), ["foreign"]);
	removeStagedAgyHome(staged);
});

test("stale home sweep covers both engine prefixes", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-dual-sweep-"));
	try {
		const names = [
			"acp-home-4194303-stale",
			"agy-home-4194304-stale",
			`acp-home-${process.pid}-live`,
			`agy-home-${process.pid}-live`,
		];
		for (const name of names) fs.mkdirSync(path.join(root, name));
		sweepStagedAgyHomes(root, (pid) => pid === process.pid);
		assert.equal(fs.existsSync(path.join(root, "acp-home-4194303-stale")), false);
		assert.equal(fs.existsSync(path.join(root, "agy-home-4194304-stale")), false);
		assert.equal(fs.existsSync(path.join(root, `acp-home-${process.pid}-live`)), true);
		assert.equal(fs.existsSync(path.join(root, `agy-home-${process.pid}-live`)), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("home removal refuses non-staged basenames", () => {
	// The rm guard exists so a stray path can never recursively delete an
	// arbitrary directory; only staged home basenames pass.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-guard-"));
	try {
		const foreign = path.join(root, "not-a-home");
		fs.mkdirSync(foreign);
		removeStagedAgyHome(foreign);
		assert.equal(fs.existsSync(foreign), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
