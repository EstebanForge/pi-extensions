// /agy auth tests against the scripted fake ACP server (authenticate ->
// {}), plus failure paths: dead binary, concurrent run, missing token.
// Fully offline; the token directory is a fixture, never the real one.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { runAcpAuth } from "../src/acp/auth.js";
import { readAcpAuthVerified } from "../src/acp/setup.js";

const FAKE_SERVER = fileURLToPath(new URL("./helpers/fake-acp-server.mjs", import.meta.url));

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-auth-"));
}

/** Wire a fake-server run whose token directory is a fixture under `dir`.
 *  `scenario` picks the fake server script (happy: session/new answers;
 *  auth-required: session/new answers -32000). */
function authOpts(dir: string, scenario = "happy") {
	return {
		bin: process.execPath,
		binArgs: [FAKE_SERVER],
		cwd: dir,
		extraEnv: { ACP_FAKE_SCENARIO: scenario, ACP_FAKE_LOG: path.join(dir, "fake-log.jsonl") },
		tokenDir: path.join(dir, "token-fixture"),
		authVerifiedFile: path.join(dir, "verified.json"),
		tokenGraceMs: 200,
		timeoutMs: 15_000,
	};
}

function seedToken(dir: string): void {
	const tokenDir = path.join(dir, "token-fixture");
	fs.mkdirSync(tokenDir, { recursive: true });
	fs.writeFileSync(path.join(tokenDir, "acp_token.json"), "{}");
}

describe("acp/auth runAcpAuth", () => {
	test("sends authenticate with the oauth-personal method and succeeds when the token is present", async () => {
		const dir = tmpDir();
		const logPath = path.join(dir, "fake-log.jsonl");
		seedToken(dir);
		const r = await runAcpAuth(authOpts(dir));
		assert.equal(r.ok, true);
		assert.equal(r.error, undefined);
		// Every verified success records the bridge-side marker so ensureAcpReady
		// stops reporting login-pending on servers that never write a token file.
		assert.equal(readAcpAuthVerified(path.join(dir, "verified.json")), true);
		assert.equal(r.note, undefined);
		const requests = fs
			.readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { method?: string; params?: { methodId?: string } });
		assert.ok(
			requests.some((m) => m.method === "authenticate" && m.params?.methodId === "oauth-personal"),
			"the authenticate RPC must carry the oauth-personal method id",
		);
	});

	test("a dead binary fails with an error, not a hang", async () => {
		const r = await runAcpAuth({ bin: path.join(tmpDir(), "no-such-server.par"), timeoutMs: 5_000, tokenDir: path.join(tmpDir(), "t") });
		assert.equal(r.ok, false);
		assert.ok(r.error && r.error.length > 0);
	});

	test("a second concurrent run fails fast instead of racing the token write", async () => {
		const dir = tmpDir();
		seedToken(dir);
		const first = runAcpAuth(authOpts(dir));
		const second = await runAcpAuth(authOpts(dir));
		const a = await first;
		assert.equal(a.ok, true);
		assert.equal(second.ok, false);
		assert.match(second.error ?? "", /already running/);
	});

	test("authenticate replying without a token file is verified through a live session probe", async () => {
		// 1.1.1 servers can authenticate from artifacts outside antigravity-acp
		// (legacy ~/.gemini credential files) and never write acp_token.json.
		// The session probe separates that from a hollow accept: fake "happy"
		// answers session/new, so this is a real sign-in.
		const dir = tmpDir();
		const r = await runAcpAuth(authOpts(dir));
		assert.equal(r.ok, true);
		assert.match(r.note ?? "", /existing credentials/);
		assert.equal(readAcpAuthVerified(path.join(dir, "verified.json")), true);
	});

	test("authenticate replying without credentials or a token stays a distinct failure", async () => {
		// Fake "auth-required" answers -32000 on session/new: the accept was
		// hollow, nothing is signed in, no marker is written.
		const dir = tmpDir();
		const r = await runAcpAuth(authOpts(dir, "auth-required"));
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /usable credentials/);
		assert.equal(readAcpAuthVerified(path.join(dir, "verified.json")), false);
	});
});
