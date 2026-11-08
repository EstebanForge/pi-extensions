// ACP connection stderr redaction: a secret the server prints to stderr must
// never leave the connection unredacted, on any surface (public getter, exit
// info, pending-request rejection reason).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe } from "vitest";
import { fileURLToPath } from "node:url";
import { AcpConnection, translateError } from "../src/acp/connection.js";
import { JsonRpcResponseError } from "../src/acp/jsonrpc.js";

test("acp connection: stderr tail and exit info are redacted", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-conn-"));
	const exits: Array<{ stderrTail: string }> = [];
	const conn = new AcpConnection({
		cwd: dir,
		bin: process.execPath,
		// Prints a secret-shaped token to stderr, lingers past the write so the
		// data event lands, then exits before initialize resolves.
		binArgs: [
			"-e",
			`console.error("boom key AIzaSyA-1234567890abcdefghijklmnopqrstu"); setTimeout(() => process.exit(1), 100);`,
		],
		log: () => {},
		onUpdate: () => {},
		onExit: (info) => exits.push(info),
	});
	await assert.rejects(conn.start());
	assert.ok(exits.length > 0, "exit fired");
	for (const tail of [conn.stderrTail, exits[0]!.stderrTail]) {
		assert.ok(tail.includes("<redacted>"), "tail is redacted");
		assert.equal(tail.includes("AIzaSyA"), false, "raw secret absent");
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

test("acp connection: a token split across stderr chunks is still redacted", async () => {
	// Pins the boundary design: chunks accumulate raw, redaction runs on the
	// reassembled tail, so neither half alone matches a secret pattern.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-conn-"));
	const exits: Array<{ stderrTail: string }> = [];
	const conn = new AcpConnection({
		cwd: dir,
		bin: process.execPath,
		binArgs: [
			"-e",
			[
				`process.stderr.write("split key AIzaSy");`,
				`setTimeout(() => {`,
				`  process.stderr.write("A-1234567890abcdefghijklmnopqrstu\\n");`,
				`  setTimeout(() => process.exit(1), 100);`,
				`}, 50);`,
			].join(""),
		],
		log: () => {},
		onUpdate: () => {},
		onExit: (info) => exits.push(info),
	});
	await assert.rejects(conn.start());
	assert.ok(exits.length > 0, "exit fired");
	for (const tail of [conn.stderrTail, exits[0]!.stderrTail]) {
		assert.ok(tail.includes("<redacted>"), "reassembled token redacted");
		assert.equal(tail.includes("1234567890abcdefghijklmn"), false, "token body absent");
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

test("acp connection: a stdout frame flood kills the connection instead of growing memory", async () => {
	// 34MB with no newline breaches the 32MB frame cap: start() must reject
	// with a typed reason and the exit path must fire, not buffer forever.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-conn-"));
	const exits: Array<{ stderrTail: string }> = [];
	const conn = new AcpConnection({
		cwd: dir,
		bin: process.execPath,
		binArgs: [
			"-e",
			// Flood stdout, and exit only when the write has fully drained: a
			// timer here would race the parent's drain speed (slow CI workers
			// read slower than the 34MB flows) and kill the flood mid-write.
			`process.stdout.write("x".repeat(34*1024*1024), () => process.exit(0));`,
		],
		log: () => {},
		onUpdate: () => {},
		onExit: (info) => exits.push(info),
	});
	let rejection: unknown;
	try {
		await conn.start();
	} catch (err) {
		rejection = err;
	}
	assert.match((rejection as Error)?.message ?? "", /frame overflow/i);
	assert.ok(exits.length > 0, "exit fired");
	fs.rmSync(dir, { recursive: true, force: true });
}, 30_000);

test("native ACP home survives until the agy process exits", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-home-kill-"));
	const processDir = path.join(dir, "staging");
	let notifyExit!: () => void;
	const exited = new Promise<void>((resolve) => { notifyExit = resolve; });
	const conn = new AcpConnection({
		cwd: dir,
		bin: process.execPath,
		binArgs: [fileURLToPath(new URL("./helpers/fake-acp-server.mjs", import.meta.url))],
		isolateHome: { geminiHome: path.join(dir, ".gemini"), parentDir: processDir },
		log: () => {},
		onUpdate: () => {},
		onExit: notifyExit,
	});
	try {
		fs.mkdirSync(path.join(dir, ".gemini", "config"), { recursive: true });
		await conn.start();
		assert.equal(fs.readdirSync(processDir).filter((name) => name.startsWith("acp-home-")).length, 1);
		conn.kill();
		assert.equal(fs.readdirSync(processDir).filter((name) => name.startsWith("acp-home-")).length, 1);
		await exited;
		assert.equal(fs.readdirSync(processDir).filter((name) => name.startsWith("acp-home-")).length, 0);
	} finally {
		conn.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("acp connection errors", () => {
	test("auth errors point at the shared agy CLI sign-in", () => {
		const translated = translateError("session/prompt", new JsonRpcResponseError({ code: -32000, message: "Authentication required" }));
		assert.equal(translated.name, "AcpAuthError");
		assert.match(translated.message, /Run agy in your terminal/);
	});
});
