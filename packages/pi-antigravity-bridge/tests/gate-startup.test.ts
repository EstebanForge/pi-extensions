// Approval-gate startup through the real factory: the shadow bash replaces
// pi's bash for every model, so it must keep pi's shell settings, and the
// gate must stage even when bridgeTools hides every pi tool. Runs via the
// shared helper (tests/helpers/gate-session.ts): real session_start handlers
// in a scratch HOME, agent dir, and workspace with a stub agy (AGY_BIN).

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { globalBridgeEntry, probeModel, startSession } from "./helpers/gate-session.js";
import type { AnyToolDefinition } from "../src/approval-gate.js";

async function runBash(tool: AnyToolDefinition, command: string): Promise<string> {
	const result = await tool.execute("call-1", { command }, undefined, undefined, undefined as never);
	return result.content.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : "")).join("");
}

const gateOn = { engine: "stream-json", approvals: { gateMode: "shadow", mode: "allow" } };

test("gate startup: shadow bash keeps pi's shellCommandPrefix", { timeout: 30000 }, async () => {
	const session = await startSession(gateOn, { shellCommandPrefix: "export AGY_GATE_PROBE=prefixed" });
	try {
		const bash = session.tools.get("bash");
		assert.ok(bash, "gate on must register the bash shadow");
		assert.equal((await runBash(bash, 'printf %s "$AGY_GATE_PROBE"')).trim(), "prefixed");
	} finally {
		await session.shutdown();
	}
});

test("gate startup: shadow bash keeps pi's shellPath", { timeout: 30000 }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-shell-"));
	const shell = path.join(dir, "probe-shell");
	// A shell wrapper that marks every command it runs.
	fs.writeFileSync(shell, '#!/bin/sh\nexport AGY_SHELL_PROBE=wrapped\nexec /bin/sh "$@"\n', { mode: 0o755 });
	const session = await startSession(gateOn, { shellPath: shell });
	try {
		const bash = session.tools.get("bash");
		assert.ok(bash, "gate on must register the bash shadow");
		assert.equal((await runBash(bash, 'printf %s "$AGY_SHELL_PROBE"')).trim(), "wrapped");
	} finally {
		await session.shutdown();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("gate startup: shadow bash accepts a file:// shellPath like pi", { timeout: 30000 }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-shell-"));
	const shell = path.join(dir, "probe-shell");
	fs.writeFileSync(shell, '#!/bin/sh\nexport AGY_SHELL_PROBE=wrapped\nexec /bin/sh "$@"\n', { mode: 0o755 });
	const session = await startSession(gateOn, { shellPath: pathToFileURL(shell).href });
	try {
		const bash = session.tools.get("bash");
		assert.ok(bash, "gate on must register the bash shadow");
		assert.equal((await runBash(bash, 'printf %s "$AGY_SHELL_PROBE"')).trim(), "wrapped");
	} finally {
		await session.shutdown();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("gate startup: bridgeTools none still stages a forced gate", { timeout: 30000 }, async () => {
	const session = await startSession({ ...gateOn, bridgeTools: "none" }, {});
	try {
		for (const name of ["bash", "write", "edit"]) {
			assert.ok(session.tools.has(name), `bridgeTools none must not drop the ${name} shadow`);
		}
	} finally {
		await session.shutdown();
	}
});

test("gate startup: bridgeTools none with the gate off registers no shadows", { timeout: 30000 }, async () => {
	const session = await startSession(
		{ engine: "stream-json", bridgeTools: "none", approvals: { gateMode: "off" } },
		{},
	);
	try {
		for (const name of ["bash", "write", "edit"]) assert.ok(!session.tools.has(name), `unexpected ${name} shadow`);
	} finally {
		await session.shutdown();
	}
});

test("gate startup: a throwing getSettings still stages the gate", { timeout: 30000 }, async () => {
	// Shell fidelity is cosmetic; the gate must survive a host whose
	// getSettings throws (the twin falls back to default shell options).
	const session = await startSession(gateOn, () => {
		throw new Error("host skew: settings unavailable");
	});
	try {
		for (const name of ["bash", "write", "edit"]) {
			assert.ok(session.tools.has(name), `a throwing getSettings must not drop the ${name} shadow`);
		}
		const bash = session.tools.get("bash");
		assert.ok(bash, "gate on must register the bash shadow");
		assert.equal((await runBash(bash, "printf %s ok")).trim(), "ok");
	} finally {
		await session.shutdown();
	}
});

test("gate startup: bridgeTools none never registers the listener globally", { timeout: 30000 }, async () => {
	// none exposes no pi tools, so the global config entry would only
	// announce the listener to agy processes the user opted out of.
	const session = await startSession({ ...gateOn, bridgeTools: "none" }, {});
	try {
		assert.ok(session.tools.has("bash"), "gate must still stage under none");
		assert.equal(
			globalBridgeEntry(session.home).includes(`pi-bridge-${process.pid}`),
			false,
			"none must not write a global pi-bridge entry",
		);
	} finally {
		await session.shutdown();
	}
});

test("gate startup: normal bridge tools register the listener globally", { timeout: 30000 }, async () => {
	// Guard for the none skip: with tools exposed the global per-pid entry
	// is still written so global-config-only agy builds find the bridge.
	const session = await startSession(gateOn, {});
	try {
		assert.ok(
			globalBridgeEntry(session.home).includes(`pi-bridge-${process.pid}`),
			"normal bridge tools must keep the global pi-bridge entry",
		);
	} finally {
		await session.shutdown();
	}
});

test("gate startup: a staged gate clears the turn refusal", { timeout: 30000 }, async () => {
	// The success-path counterpart to the provider refusal: after a clean
	// stage, gateUnavailable must be cleared, or every gated session refuses
	// every turn until restart.
	const session = await startSession(gateOn, {});
	try {
		assert.ok(session.providerDef?.streamSimple, "session_start must register the provider");
		const stream = session.providerDef.streamSimple(
			{ ...probeModel },
			normalizeContext({
				systemPrompt: undefined,
				messages: [{ role: "user", content: "gate probe", timestamp: Date.now() }],
			}),
			{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
		);
		const events: unknown[] = [];
		for await (const ev of stream) events.push(ev);
		assert.equal(
			events.some((e) => JSON.stringify(e).includes("approval gate is required but not active")),
			false,
			"a staged gate must not refuse turns",
		);
	} finally {
		await session.shutdown();
	}
});
