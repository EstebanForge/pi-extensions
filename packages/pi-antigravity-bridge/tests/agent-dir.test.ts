// Issue #17: every bridge-owned path must follow pi's agent-dir resolution.
// These tests pin the PRODUCTION default path by setting PI_CODING_AGENT_DIR
// (what getAgentDir() reads) — no override params — and asserting each helper
// resolves under the relocated dir. Vanilla defaults (~/.pi/agent) are
// byte-identical to the pre-fix hardcoded paths, so they are not re-pinned
// here; the shape tests in the per-module suites cover the layouts.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { bridgeDir, configPath, extensionsDataDir, logsDir } from "../src/config.js";
import { suppressionMarkerPath } from "../src/mcp-registration.js";
import { agyHomeStagingDir } from "../src/acp/home.js";
import { patchBackupDir } from "../src/patch-cleanup.js";
import { bridgeMcpConfigDir } from "../src/mcp-server.js";

test("PI_CODING_AGENT_DIR relocates every bridge-owned path (issue #17)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agentdir-"));
	const agentDir = path.join(root, ".gentle-shell", "agent");
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		assert.equal(bridgeDir(), path.join(agentDir, "antigravity-bridge"));
		assert.equal(configPath(), path.join(agentDir, "antigravity-bridge", "config.json"));
		assert.equal(patchBackupDir(), path.join(agentDir, "antigravity-bridge", "pi-patch-backup"));
		assert.equal(agyHomeStagingDir(), path.join(agentDir, "antigravity-bridge", "acp-homes"));
		assert.equal(bridgeMcpConfigDir(), path.join(agentDir, "antigravity-bridge", `agy-mcp-${process.pid}`));

		const configRoot = path.dirname(agentDir);
		assert.equal(extensionsDataDir(), path.join(configRoot, "extensions-data", "estebanforge", "pi-antigravity-bridge"));
		assert.equal(logsDir(), path.join(configRoot, "extensions-data", "estebanforge", "pi-antigravity-bridge", "logs"));
		assert.equal(
			suppressionMarkerPath(),
			path.join(configRoot, "extensions-data", "estebanforge", "pi-antigravity-bridge", "suppression.json"),
		);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
