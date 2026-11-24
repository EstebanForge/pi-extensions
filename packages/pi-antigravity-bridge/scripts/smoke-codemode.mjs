// Live codemode round-trip smoke (AGY_ACP_LIVE=1; real agy, billed inference).
//
// The spike (probe-codemode.mjs) drove the engine against a hand-built
// sandbox. This smoke closes the remaining gap from the release review:
// the FULL chain through a REAL pi session -
//   agy -> bridge MCP catalog (codemode mode) -> pi tool round-trip
//   -> pi's native codemode extension -> sandbox with pi's REAL tools
//   -> result back into agy's reply.
//
// Proof design: a secret is pre-planted in a file the model has never seen.
// The only route to it is a pi-side read executed inside the sandbox, and
// the copy proves a pi-side write ran there too. A direct bridge read is
// impossible: in codemode mode builtins are not in the authorized set.
//
// Run: AGY_ACP_LIVE=1 node scripts/smoke-codemode.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (real agy, billed inference)");
	process.exit(1);
}
// The bridge reads config per call with no cache: env-only flip, the user's
// config.json stays untouched.
process.env.AGY_BRIDGE_TOOLS = "codemode";

const { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, createCodemodeExtension } =
	await import("@earendil-works/pi-coding-agent");

const BRIDGE_EXTENSION = new URL("../extensions/index.ts", import.meta.url).pathname;
const SECRET = "MARJORAM-4-2-SMOKE";

const proj = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-codemode-smoke-"));
const secretPath = path.join(proj, "secret.txt");
const copyPath = path.join(proj, "copy.txt");
fs.writeFileSync(secretPath, SECRET, "utf8");

const checks = [];
const check = (name, ok, detail = "") => {
	checks.push(ok);
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
};

const resourceLoader = new DefaultResourceLoader({
	cwd: proj,
	agentDir: getAgentDir(),
	noExtensions: true, // CLI/additional paths only: keeps the INSTALLED fleet bridge out
	extensionFactories: [createCodemodeExtension({ mode: "on" })],
	additionalExtensionPaths: [BRIDGE_EXTENSION],
});
await resourceLoader.reload();

const settingsManager = SettingsManager.create(proj);
settingsManager.applyOverrides({ defaultTools: ["+codemode"] });

const { session } = await createAgentSession({
	resourceLoader,
	settingsManager,
	sessionManager: SessionManager.inMemory(),
	thinkingLevel: "low",
});

try {
	await session.bindExtensions({});

	// Extension provider registrations flush at bind time into the
	// session's own model runtime; a runtime created before bind cannot
	// see them (first run fell back to the default zai model).
	const mr = session.modelRuntime;
	const available = await mr.getAvailable();
	let model = available.find((m) => m.provider === "antigravity");
	if (!model) model = mr.getModel("antigravity", "gemini-4-hydrogen-medium");
	check("antigravity model registered by the tree extension", !!model, model ? `${model.provider}/${model.id}` : "none found");
	if (!model) {
		// Skip the billed run: it would exercise the wrong provider and
		// pass vacuously.
		session.dispose();
		console.log(`\n0/${checks.length} checks passed - SMOKE FAILED (no bridge model)`);
		process.exit(1);
	}
	await session.setModel(model);

	const active = session.getActiveToolNames();
	check("pi session has codemode active", active.includes("codemode"), `active: ${active.join(", ")}`);
	check("session model is the bridge provider", session.model?.provider === "antigravity", session.model?.provider);

	let reply = "";
	const toolcallEvents = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update") {
			const a = event.assistantMessageEvent;
			if (a.type === "text_delta") reply += a.delta;
			else if (a.type === "text_end" && a.content) reply = a.content;
			else if (typeof a.type === "string" && a.type.startsWith("toolcall")) toolcallEvents.push(JSON.stringify(a));
		}
	});

	const prompt =
		"Use the codemode tool exactly once, with ONE script. The script must: " +
		`read the file ${secretPath} with tools.read, then write that file's exact content to ${copyPath} with tools.write, ` +
		"then return the content string. Reply with only the returned content.";
	try {
		await session.prompt(prompt);
		check("prompt run resolved", true);
	} catch (err) {
		check("prompt run resolved", false, String(err?.message ?? err));
	} finally {
		unsubscribe();
	}

	let copy = "";
	try {
		copy = fs.readFileSync(copyPath, "utf8");
	} catch {
		/* asserted below */
	}
	check("copy exists with the secret (pi-side write ran inside the sandbox)", copy.includes(SECRET), copy.trim());
	check("reply carries the secret (read -> script return -> agy -> pi)", reply.includes(SECRET), reply.trim().slice(0, 120));
	check("agy called the codemode tool (pi-side event)", toolcallEvents.some((e) => e.includes("codemode")), `${toolcallEvents.length} toolcall event(s)`);
} finally {
	session.dispose();
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed${failed ? " - SMOKE FAILED" : " - codemode round trip verified live"}`);
process.exit(failed ? 1 : 0);
