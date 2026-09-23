// ACP connection stderr redaction: a secret the server prints to stderr must
// never leave the connection unredacted, on any surface (public getter, exit
// info, pending-request rejection reason).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { AcpConnection } from "../src/acp/connection.js";

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
