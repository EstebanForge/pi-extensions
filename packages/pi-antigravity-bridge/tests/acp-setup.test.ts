// ACP setup module tests. Fully offline: the registry and the archive come
// from an injected fetch, unpacking from an injected copier, and every path
// (install root, settings dir, env) points at a temp dir.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import {
	buildIdFromArchive,
	ensureAcpReady,
	inspectAcpSetup,
	MANUAL_SETUP,
	platformKey,
	readAuthState,
	resolveInstalledArgs,
	writeAcpAuthVerified,
	writeAuthType,
} from "../src/acp/setup.js";

const BUILD = "agy_acp_server_20991231_01_TEST";
const ARCHIVE = `https://dl.google.com/agy-extensions/releases/x/agy-acp-server-${BUILD}-${platformKey().replace("aarch64", "arm64")}.zip`;

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-setup-"));
}

function fakeFetch(registryBody: unknown, archiveBody = "fake-zip-bytes"): typeof fetch {
	return (async (url: Parameters<typeof fetch>[0]) => {
		if (String(url).endsWith(".zip")) {
			return new Response(archiveBody, { status: 200 });
		}
		return new Response(JSON.stringify(registryBody), { status: 200 });
	}) as typeof fetch;
}

function fakeUnpack(archive: string, dest: string): Promise<void> {
	const bin = path.join(dest, "agy_acp_server.par");
	fs.writeFileSync(bin, "#!/bin/sh\n");
	fs.chmodSync(bin, 0o755);
	void archive;
	return Promise.resolve();
}

const REGISTRY = {
	id: "antigravity-acp",
	distribution: {
		binary: {
			[platformKey()]: { archive: ARCHIVE, cmd: "./agy_acp_server.par" },
		},
	},
};

describe("acp/setup registry parsing", () => {
	test("buildIdFromArchive parses the real registry URL shape", () => {
		const url =
			"https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_20260818_01_RC01-darwin-arm64.zip";
		assert.equal(buildIdFromArchive(url), "agy_acp_server_20260818_01_RC01");
	});

	test("buildIdFromArchive rejects unrecognized names", () => {
		assert.throws(() => buildIdFromArchive("https://x/thing.zip"));
	});

	test("platformKey maps platform+arch", () => {
		assert.match(platformKey(), /^(darwin|linux|windows)-(aarch64|x86_64)$/);
	});
});

describe("acp/setup auth state", () => {
	test("absent settings and token = unconfigured", () => {
		assert.deepEqual(readAuthState(tmpDir()), { configured: false });
	});

	test("settings.json type is detected", () => {
		const dir = tmpDir();
		writeAuthType("gemini-api-key", dir);
		assert.deepEqual(readAuthState(dir), { configured: true, type: "gemini-api-key" });
		// Fresh file is created user-only (matches acp_token.json 0600).
		const mode = fs.statSync(path.join(dir, "settings.json")).mode & 0o777;
		assert.equal(mode, 0o600);
	});

	test("acp_token.json presence means configured without reading it", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, "acp_token.json"), "credential-not-read");
		assert.deepEqual(readAuthState(dir), { configured: true, type: "token" });
	});

	test("writeAuthType preserves unrelated settings and auth keys", () => {
		const dir = tmpDir();
		const file = path.join(dir, "settings.json");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({ auth: { type: "oauth-personal", keepme: 1 }, gcp: { project: "p" } }),
		);
		writeAuthType("gemini-api-key", dir);
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
			auth: Record<string, unknown>;
			gcp?: unknown;
		};
		assert.equal(parsed.auth.type, "gemini-api-key");
		assert.equal(parsed.auth.keepme, 1);
		assert.deepEqual(parsed.gcp, { project: "p" });
	});
});

describe("acp/setup registry args", () => {
	const REGISTRY_WITH_ARGS = {
		id: "antigravity-acp",
		distribution: {
			binary: {
				[platformKey()]: { archive: ARCHIVE, cmd: "./agy_acp_server.par", args: ["--uid="] },
			},
		},
	};

	test("install records registry args and returns them", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			authVerifiedFile: path.join(tmpDir(), "none.json"),
			env: {},
			fetchImpl: fakeFetch(REGISTRY_WITH_ARGS),
			unpack: fakeUnpack,
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.deepEqual(status.args, ["--uid="]);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, BUILD, "args.json"), "utf8")), ["--uid="]);
	});

	test("resolveInstalledArgs recovers recorded args for the managed install", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			authVerifiedFile: path.join(tmpDir(), "none.json"),
			env: {},
			fetchImpl: fakeFetch(REGISTRY_WITH_ARGS),
			unpack: fakeUnpack,
		});
		// Second run: the managed `current` layout resolves with no network,
		// and the early-return path must still surface the recorded args.
		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			env: {},
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.binarySource, "existing");
		assert.deepEqual(status.args, ["--uid="]);
		assert.deepEqual(resolveInstalledArgs({ installRoot: root, env: {} }), ["--uid="]);
		// Regression: setup persists the managed path into acp.bin, so on the
		// next turn the config candidate wins over `current`. Args must still
		// resolve by path identity, not by which candidate matched.
		const managedBin = path.join(root, BUILD, "agy_acp_server.par");
		assert.deepEqual(resolveInstalledArgs({ installRoot: root, env: {}, configBin: managedBin }), ["--uid="]);
	});

	test("env and config overrides own their argv and get no registry args", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			authVerifiedFile: path.join(tmpDir(), "none.json"),
			env: {},
			fetchImpl: fakeFetch(REGISTRY_WITH_ARGS),
			unpack: fakeUnpack,
		});
		const shim = path.join(root, "shim.sh");
		fs.writeFileSync(shim, "#!/bin/sh\n");
		fs.chmodSync(shim, 0o755);
		assert.deepEqual(resolveInstalledArgs({ installRoot: root, env: { AGY_ACP_BIN: shim } }), []);
		assert.deepEqual(resolveInstalledArgs({ installRoot: root, env: {}, configBin: shim }), []);
	});

	test("non-string and non-array registry args are dropped", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		const bad = {
			id: "antigravity-acp",
			distribution: { binary: { [platformKey()]: { archive: ARCHIVE, cmd: "./agy_acp_server.par", args: ["--uid=", 7, null] } } },
		};
		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			authVerifiedFile: path.join(tmpDir(), "none.json"),
			env: {},
			fetchImpl: fakeFetch(bad),
			unpack: fakeUnpack,
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.deepEqual(status.args, ["--uid="]);
	});
});

describe("acp/setup ensureAcpReady", () => {
	test("ready installation is a no-op with no network", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		fs.mkdirSync(path.join(root, "current"), { recursive: true });
		const bin = path.join(root, "current", "agy_acp_server.par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);
		writeAuthType("gemini-api-key", gdir);

		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			env: {},
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.bin, bin);
		assert.equal(status.binarySource, "existing");
		assert.equal(status.auth, "gemini-api-key");
		assert.deepEqual(status.actions, []);
		assert.equal(status.needsLogin, false);
	});

	test("installs from the registry when missing; oauth-personal is the default even with GEMINI_API_KEY set", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			// Hermetic: never let a developer-machine marker flip the assertion.
			authVerifiedFile: path.join(tmpDir(), "none.json"),
			env: { GEMINI_API_KEY: "k" },
			fetchImpl: fakeFetch(REGISTRY),
			unpack: fakeUnpack,
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.binarySource, "installed");
		// The subscription login is the default; an exported key must not flip it
		// (the key path is metered paid API, not the Antigravity plan).
		assert.equal(status.auth, "oauth-personal");
		assert.equal(status.needsLogin, true);
		assert.equal(status.bin, path.join(root, BUILD, "agy_acp_server.par"));
		// Managed layout: current symlink + recorded zip sha256.
		assert.equal(fs.readlinkSync(path.join(root, "current")), BUILD);
		const sha = fs.readFileSync(path.join(root, BUILD, "zip.sha256"), "utf8");
		assert.match(sha, /^[0-9a-f]{64}  /);
		// Auth was written before any server could spawn.
		assert.deepEqual(readAuthState(gdir), { configured: true, type: "oauth-personal" });
		assert.match(status.actions.join("\n"), /installed ACP server build/);
	});

	test("oauth-personal wins when GEMINI_API_KEY is also exported", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		writeAuthType("oauth-personal", gdir);
		const settingsFile = path.join(gdir, "settings.json");
		const before = fs.readFileSync(settingsFile, "utf8");
		fs.mkdirSync(path.join(root, "current"), { recursive: true });
		const bin = path.join(root, "current", "agy_acp_server.par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);

		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			// Hermetic: never let a developer-machine marker flip the assertion.
			authVerifiedFile: path.join(tmpDir(), "none.json"),
			env: { GEMINI_API_KEY: "k" },
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		// Subscription login stays selected; the key is not written anywhere and
		// settings.json is untouched (the server uses auth.type, not env presence).
		assert.equal(status.auth, "oauth-personal");
		assert.deepEqual(status.actions, []);
		// settings.json alone is not a login: the token file only appears after
		// the browser round-trip, so setup must keep reporting login-pending
		// (the session_start self-heal repeats the notice until then).
		assert.equal(status.needsLogin, true);
		assert.equal(fs.readFileSync(settingsFile, "utf8"), before);
		assert.equal(fs.readdirSync(gdir).includes("acp_token.json"), false);
	});

	test("a completed login (token file present) is not login-pending", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		writeAuthType("oauth-personal", gdir);
		fs.writeFileSync(path.join(gdir, "acp_token.json"), "{}");
		fs.mkdirSync(path.join(root, "current"), { recursive: true });
		const bin = path.join(root, "current", "agy_acp_server.par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);

		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			env: {},
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.auth, "oauth-personal");
		assert.deepEqual(status.actions, []);
		assert.equal(status.needsLogin, false);
	});

	test("a verified sign-in marker suppresses login-pending without a token file", async () => {
		// 1.1.1 servers can hold credentials the bridge cannot see (legacy
		// ~/.gemini artifacts): after a verified sign-in the nag must stop even
		// though acp_token.json never appears.
		const root = tmpDir();
		const gdir = tmpDir();
		writeAuthType("oauth-personal", gdir);
		const verifiedFile = path.join(tmpDir(), "verified.json");
		writeAcpAuthVerified(verifiedFile);
		fs.mkdirSync(path.join(root, "current"), { recursive: true });
		const bin = path.join(root, "current", "agy_acp_server.par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);

		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			authVerifiedFile: verifiedFile,
			env: {},
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.needsLogin, false);
	});

	test("install failure returns the manual fallback text", async () => {
		const status = await ensureAcpReady({
			installRoot: tmpDir(),
			geminiDir: tmpDir(),
			env: {},
			fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
		});
		assert.equal(status.ok, false);
		if (status.ok) return;
		assert.equal(status.stage, "install");
		assert.match(status.error, /HTTP 500/);
		assert.equal(status.manual, MANUAL_SETUP);
	});

	test("env binary wins and skips the registry", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		writeAuthType("gemini-api-key", gdir);
		const bin = path.join(tmpDir(), "par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);
		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			env: { AGY_ACP_BIN: bin },
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.binarySource, "env");
		assert.equal(status.bin, bin);
	});
});

describe("acp/setup inspectAcpSetup", () => {
	test("empty dirs report nothing configured", () => {
		const state = inspectAcpSetup({ installRoot: tmpDir(), geminiDir: tmpDir(), env: {} });
		assert.equal(state.bin, null);
		assert.equal(state.source, null);
		assert.equal(state.auth, null);
	});

	test("a verified marker reads as healthy when no token file exists", () => {
		// Servers that authenticate from artifacts outside antigravity-acp never
		// write acp_token.json; doctor must show that state as verified, not bare.
		const gdir = tmpDir();
		writeAuthType("oauth-personal", gdir);
		const verifiedFile = path.join(tmpDir(), "verified.json");
		writeAcpAuthVerified(verifiedFile);
		const state = inspectAcpSetup({ installRoot: tmpDir(), geminiDir: gdir, authVerifiedFile: verifiedFile, env: {} });
		assert.equal(state.auth, "oauth-personal (verified, no token file)");
	});
});
