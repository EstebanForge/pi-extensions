// AskAntigravity gate parity, argv half: a staged gate must ride the consult
// spawn (--add-dir of the per-pid bridge dir, same as driver.ts), and the
// gate-off path must stay clean of it. AGY_BIN is an argv recorder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { startSession } from "./helpers/gate-session.js";
import { bridgeMcpConfigDir } from "../src/mcp-server.js";

const gateOn = { engine: "stream-json", askTool: true, approvals: { gateMode: "shadow", mode: "allow" } };
const gateOff = { engine: "stream-json", askTool: true, bridgeTools: "none", approvals: { gateMode: "off" } };

/** agy stub that dumps its argv and exits 0 (empty stdout fails the consult
 *  result; only the argv matters here). */
function recorderStub(dir: string): string {
	const sh = path.join(dir, "agy");
	fs.writeFileSync(sh, `#!/bin/sh\nprintf '%s\\n' "$@" > "$AGY_ARGV_OUT"\nexit 0\n`, { mode: 0o755 });
	return sh;
}

async function consultArgv(
	session: Awaited<ReturnType<typeof startSession>>,
	argvFile: string,
): Promise<string[]> {
	const ask = session.tools.get("AskAntigravity");
	assert.ok(ask, "askTool on must register AskAntigravity");
	await ask.execute("t1", { prompt: "gate probe" }, undefined, undefined, {
		cwd: session.cwd,
		model: undefined,
	} as never);
	return fs.readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
}

test("ask gate: a staged gate rides the consult spawn", { timeout: 30000 }, async () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ask-"));
	const argvFile = path.join(out, "argv");
	const prevOut = process.env.AGY_ARGV_OUT;
	const prevBin = process.env.AGY_BIN;
	const session = await startSession(gateOn, {});
	try {
		process.env.AGY_ARGV_OUT = argvFile;
		process.env.AGY_BIN = recorderStub(out);
		const argv = await consultArgv(session, argvFile);
		const gateDir = bridgeMcpConfigDir();
		const i = argv.indexOf("--add-dir");
		assert.ok(i !== -1, `consult argv must carry --add-dir, got: ${argv.join(" ")}`);
		assert.ok(
			argv.slice(i).includes(gateDir),
			`consult argv must add the staged gate dir (${gateDir}), got: ${argv.join(" ")}`,
		);
	} finally {
		await session.shutdown();
		if (prevOut === undefined) delete process.env.AGY_ARGV_OUT;
		else process.env.AGY_ARGV_OUT = prevOut;
		if (prevBin === undefined) delete process.env.AGY_BIN;
		else process.env.AGY_BIN = prevBin;
		fs.rmSync(out, { recursive: true, force: true });
	}
});

test("ask gate: gate off leaves the consult spawn clean", { timeout: 30000 }, async () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ask-"));
	const argvFile = path.join(out, "argv");
	const prevOut = process.env.AGY_ARGV_OUT;
	const prevBin = process.env.AGY_BIN;
	const session = await startSession(gateOff, {});
	try {
		process.env.AGY_ARGV_OUT = argvFile;
		process.env.AGY_BIN = recorderStub(out);
		const argv = await consultArgv(session, argvFile);
		assert.equal(
			argv.includes(bridgeMcpConfigDir()),
			false,
			"gate off must not add the gate dir to the consult",
		);
	} finally {
		await session.shutdown();
		if (prevOut === undefined) delete process.env.AGY_ARGV_OUT;
		else process.env.AGY_ARGV_OUT = prevOut;
		if (prevBin === undefined) delete process.env.AGY_BIN;
		else process.env.AGY_BIN = prevBin;
		fs.rmSync(out, { recursive: true, force: true });
	}
});
