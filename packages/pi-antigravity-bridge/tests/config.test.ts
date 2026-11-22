// Config tests: engine + bridgeTools knobs round-trip through load/save and
// unrelated saves never clobber them (the merge regression class).

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";

function tmpConfig(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-cfg-")), "config.json");
}

/** Clear every AGY_* env var loadConfig reads; restores them after. Boolean
 *  file-path tests must not inherit ambient env overrides (issue #23). */
function withoutAgyEnvs(run: () => void): void {
	const keys = [
		"AGY_ASK_TOOL",
		"AGY_WEB_TOOLS",
		"AGY_DIGEST",
		"AGY_SYSTEM_PROMPT",
		"AGY_SKIP_PERMISSIONS",
		"AGY_READONLY",
		"AGY_ACP_SESSION_RETRY",
	] as const;
	const prevs = keys.map((k) => [k, process.env[k]] as const);
	for (const k of keys) delete process.env[k];
	try {
		run();
	} finally {
		for (const [k, prev] of prevs) {
			if (prev === undefined) delete process.env[k];
			else process.env[k] = prev;
		}
	}
}

/** Pin process.stdout.isTTY for the duration of run(): the TTY-aware turn-cap
 *  default must not depend on ambient stdio (CI, piped vitest, TTY shells). */
function stubTTY(value: boolean | undefined, run: () => void): void {
	const out = process.stdout as unknown as { isTTY?: boolean };
	const prev = out.isTTY;
	out.isTTY = value;
	try {
		run();
	} finally {
		if (prev === undefined) delete out.isTTY;
		else out.isTTY = prev;
	}
}

test("config: defaults select the full bridge surface", () => {
	const p = tmpConfig();
	try {
		const c = loadConfig(p);
		assert.equal(c.bridgeTools, "all");
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: bridgeTools round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		for (const surface of ["all", "mcp", "none"] as const) {
			saveConfig({ bridgeTools: surface }, p);
			assert.equal(loadConfig(p).bridgeTools, surface);
		}
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: unrelated save does not clobber bridgeTools", () => {
	const p = tmpConfig();
	try {
		saveConfig({ bridgeTools: "none" }, p);
		saveConfig({ mode: "plan" }, p);
		const c = loadConfig(p);
		assert.equal(c.bridgeTools, "none");
		assert.equal(c.mode, "plan");
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: invalid bridgeTools value falls back to the default surface", () => {
	const p = tmpConfig();
	try {
		saveConfig({ bridgeTools: "bogus" as never }, p);
		assert.equal(loadConfig(p).bridgeTools, "all");
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: askTool defaults on and round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		assert.equal(loadConfig(p).askTool, true);
		saveConfig({ askTool: false }, p);
		assert.equal(loadConfig(p).askTool, false);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: digest defaults on (self-gating) and round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		assert.equal(loadConfig(p).digest, true);
		saveConfig({ digest: false }, p);
		assert.equal(loadConfig(p).digest, false);
		saveConfig({ mode: "plan" }, p);
		assert.equal(loadConfig(p).digest, false);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: systemPrompt defaults on and round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		assert.equal(loadConfig(p).systemPrompt, true);
		saveConfig({ systemPrompt: false }, p);
		assert.equal(loadConfig(p).systemPrompt, false);
		saveConfig({ mode: "plan" }, p);
		assert.equal(loadConfig(p).systemPrompt, false);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

// --- issue #23: config.json boolean keys accept the /agy vocabulary -------
// The README and /agy speak on/off, so hand editors write "off"/"false" as
// STRINGS. Any non-empty string is truthy, which silently enabled every
// option the user tried to disable. Strings now parse; junk falls back to
// the per-key default and surfaces a parse warning (surfaced by /agy doctor).

test("config: string booleans parse per the /agy vocabulary (issue #23)", () => {
	const p = tmpConfig();
	try {
		withoutAgyEnvs(() => {
			fs.writeFileSync(
				p,
				JSON.stringify({
					askTool: "off",
					webTools: "on",
					digest: "false",
					systemPrompt: "0",
					skipPermissions: "false",
					readOnly: "off",
					acp: { sessionRetryOnTimeout: "on" },
				}),
			);
			const c = loadConfig(p);
			assert.equal(c.askTool, false);
			assert.equal(c.webTools, true);
			assert.equal(c.digest, false);
			assert.equal(c.systemPrompt, false);
			assert.equal(c.skipPermissions, false);
			assert.equal(c.readOnly, false);
			assert.equal(c.acp.sessionRetryOnTimeout, true);
			assert.equal(c.parseWarnings, undefined);
		});
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: boolean junk falls back to the per-key default with a parse warning (issue #23)", () => {
	const p = tmpConfig();
	try {
		withoutAgyEnvs(() => {
			// Per-key defaults: skipPermissions true, askTool true, webTools false,
			// digest true, systemPrompt true.
			const cases: Array<[string, unknown, boolean]> = [
				["skipPermissions", "maybe", true],
				["askTool", 7, true],
				["webTools", "disabled", false],
				["digest", "", true],
				["systemPrompt", [], true],
			];
			for (const [key, junk, expectedDefault] of cases) {
				fs.writeFileSync(p, JSON.stringify({ [key]: junk }));
				const c = loadConfig(p);
				assert.equal(c[key as "askTool"], expectedDefault, `${key} must fall back to its default`);
				assert.ok(c.parseWarnings?.some((w) => w.includes(key)), `${key} junk must warn`);
			}
			// null is absent-like: falls back silently, no warning.
			fs.writeFileSync(p, JSON.stringify({ askTool: null }));
			const c = loadConfig(p);
			assert.equal(c.askTool, true);
			assert.equal(c.parseWarnings, undefined);
		});
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: acp.sessionRetryOnTimeout accepts string booleans (issue #23)", () => {
	const p = tmpConfig();
	try {
		withoutAgyEnvs(() => {
			fs.writeFileSync(p, JSON.stringify({ acp: { sessionRetryOnTimeout: "on" } }));
			assert.equal(loadConfig(p).acp.sessionRetryOnTimeout, true);
			fs.writeFileSync(p, JSON.stringify({ acp: { sessionRetryOnTimeout: "1" } }));
			assert.equal(loadConfig(p).acp.sessionRetryOnTimeout, true);
			fs.writeFileSync(p, JSON.stringify({ acp: { sessionRetryOnTimeout: "false" } }));
			assert.equal(loadConfig(p).acp.sessionRetryOnTimeout, false);
			fs.writeFileSync(p, JSON.stringify({ acp: { sessionRetryOnTimeout: "junk" } }));
			const c = loadConfig(p);
			assert.equal(c.acp.sessionRetryOnTimeout, false);
			assert.ok(c.parseWarnings?.some((w) => w.includes("acp.sessionRetryOnTimeout")));
		});
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: parse warnings stay in memory and user values stay untouched on disk (issue #23)", () => {
	const p = tmpConfig();
	try {
		withoutAgyEnvs(() => {
			fs.writeFileSync(p, JSON.stringify({ askTool: "junk" }));
			const c = loadConfig(p);
			assert.equal(c.parseWarnings?.length, 1);
			// An unrelated toggle must not rewrite the user's hand-edited value
			// and must never persist the in-memory warnings field.
			saveConfig({ mode: "plan" }, p);
			const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
			assert.equal(onDisk.askTool, "junk");
			assert.equal("parseWarnings" in onDisk, false);
		});
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: non-string enum values fall back instead of throwing (issue #23 review)", () => {
	const p = tmpConfig();
	try {
		withoutAgyEnvs(() => {
			fs.writeFileSync(
				p,
				JSON.stringify({
					defaultThinking: 5,
					bridgeTools: true,
					approvals: { gateMode: 1, mode: 2 },
					agent: 3,
					engine: 7,
				}),
			);
			const c = loadConfig(p);
			assert.equal(c.defaultThinking, "medium");
			assert.equal(c.bridgeTools, "all");
			assert.equal(c.approvals.gateMode, "auto");
			assert.equal(c.approvals.mode, "ask");
			assert.equal(c.agent, undefined);
			assert.equal(c.engine, "acp");
		});
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: AGY_SYSTEM_PROMPT env overrides the file in both directions", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_SYSTEM_PROMPT;
	try {
		saveConfig({ systemPrompt: true }, p);
		process.env.AGY_SYSTEM_PROMPT = "off";
		assert.equal(loadConfig(p).systemPrompt, false);
		saveConfig({ systemPrompt: false }, p);
		process.env.AGY_SYSTEM_PROMPT = "on";
		assert.equal(loadConfig(p).systemPrompt, true);
	} finally {
		if (prev === undefined) delete process.env.AGY_SYSTEM_PROMPT;
		else process.env.AGY_SYSTEM_PROMPT = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: turn caps default TTY-aware (headless 20m) and round-trip", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_TURN_TIMEOUT_MIN;
	try {
		delete process.env.AGY_TURN_TIMEOUT_MIN;
		// Headless branch pinned explicitly: the default must not depend on
		// ambient stdio (CI, piped vitest, TTY shells).
		stubTTY(false, () => {
			const c = loadConfig(p);
			assert.equal(c.turnTimeoutMin, 20);
			assert.equal(c.inactivityTimeoutMin, 5);
		});
		saveConfig({ turnTimeoutMin: 45, inactivityTimeoutMin: 0 }, p);
		const next = loadConfig(p);
		assert.equal(next.turnTimeoutMin, 45);
		assert.equal(next.inactivityTimeoutMin, 0);
	} finally {
		if (prev === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: turn cap defaults to 0 when stdout is a TTY", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_TURN_TIMEOUT_MIN;
	try {
		delete process.env.AGY_TURN_TIMEOUT_MIN;
		stubTTY(true, () => assert.equal(loadConfig(p).turnTimeoutMin, 0));
		stubTTY(false, () => assert.equal(loadConfig(p).turnTimeoutMin, 20));
	} finally {
		if (prev === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: turn cap sanity range 1-1440; out-of-range falls back to the TTY-aware default", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_TURN_TIMEOUT_MIN;
	try {
		delete process.env.AGY_TURN_TIMEOUT_MIN;
		stubTTY(false, () => {
			saveConfig({ turnTimeoutMin: 1440 }, p);
			assert.equal(loadConfig(p).turnTimeoutMin, 1440);
			saveConfig({ turnTimeoutMin: 1441 }, p);
			assert.equal(loadConfig(p).turnTimeoutMin, 20);
			saveConfig({ turnTimeoutMin: 0.5 }, p);
			assert.equal(loadConfig(p).turnTimeoutMin, 20);
		});
	} finally {
		if (prev === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: invalid turn cap values fall back to the defaults, 0 stays disabled", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_TURN_TIMEOUT_MIN;
	try {
		delete process.env.AGY_TURN_TIMEOUT_MIN;
		stubTTY(false, () => {
			saveConfig({ turnTimeoutMin: -3, inactivityTimeoutMin: "abc" as never }, p);
			const c = loadConfig(p);
			assert.equal(c.turnTimeoutMin, 20);
			assert.equal(c.inactivityTimeoutMin, 5);
		});
	} finally {
		if (prev === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: AGY_TURN_TIMEOUT_MIN env overrides the file, 0 disables", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_TURN_TIMEOUT_MIN;
	try {
		saveConfig({ turnTimeoutMin: 45 }, p);
		process.env.AGY_TURN_TIMEOUT_MIN = "0";
		assert.equal(loadConfig(p).turnTimeoutMin, 0);
		process.env.AGY_TURN_TIMEOUT_MIN = "junk";
		stubTTY(false, () => assert.equal(loadConfig(p).turnTimeoutMin, 20));
		// Whitespace-only must fall back too, never read as an explicit 0/disable.
		process.env.AGY_TURN_TIMEOUT_MIN = "  ";
		stubTTY(false, () => assert.equal(loadConfig(p).turnTimeoutMin, 20));
	} finally {
		if (prev === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});
