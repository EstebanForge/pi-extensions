import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { cleanupManagedAcpInstall } from "../src/acp/setup.js";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-cleanup-"));
}

function managedBuild(root: string, build = "agy_acp_server_1.1.1"): string {
	const dir = path.join(root, build);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "agy_acp_server.par"), "old server");
	fs.writeFileSync(path.join(dir, "zip.sha256"), `${"a".repeat(64)}  server.zip\n`);
	return dir;
}

test("cleanup removes marked builds and their current symlink only", () => {
	const root = tmpDir();
	const build = managedBuild(root);
	fs.symlinkSync(path.basename(build), path.join(root, "current"));
	const unrelated = path.join(root, "keep-me");
	fs.mkdirSync(unrelated);
	fs.writeFileSync(path.join(unrelated, "user-data"), "keep");

	const result = cleanupManagedAcpInstall(root);

	assert.deepEqual(result.removedBuilds, [path.basename(build)]);
	assert.equal(fs.existsSync(build), false);
	assert.equal(fs.existsSync(path.join(root, "current")), false);
	assert.equal(fs.readFileSync(path.join(unrelated, "user-data"), "utf8"), "keep");
	assert.equal(result.rootRemoved, false);
});

test("cleanup removes every marked build and removes an empty root", () => {
	const root = tmpDir();
	managedBuild(root, "agy_acp_server_1.0.0");
	managedBuild(root, "agy_acp_server_1.1.1");
	fs.symlinkSync("agy_acp_server_1.1.1", path.join(root, "current"));

	const result = cleanupManagedAcpInstall(root);

	assert.deepEqual(result.removedBuilds, ["agy_acp_server_1.0.0", "agy_acp_server_1.1.1"]);
	assert.equal(result.rootRemoved, true);
	assert.equal(fs.existsSync(root), false);
});

test("cleanup preserves unmarked binaries and symlinks outside the managed layout", () => {
	const root = tmpDir();
	const unmarked = path.join(root, "agy_acp_server_user-copy");
	fs.mkdirSync(unmarked);
	fs.writeFileSync(path.join(unmarked, "agy_acp_server.par"), "user binary");
	fs.symlinkSync("agy_acp_server_user-copy", path.join(root, "current"));

	const result = cleanupManagedAcpInstall(root);

	assert.deepEqual(result.removedBuilds, []);
	assert.equal(fs.readFileSync(path.join(unmarked, "agy_acp_server.par"), "utf8"), "user binary");
	assert.equal(fs.readlinkSync(path.join(root, "current")), "agy_acp_server_user-copy");
});

test("cleanup refuses a symlinked install root", () => {
	const parent = tmpDir();
	const actual = path.join(parent, "actual");
	managedBuild(actual);
	const root = path.join(parent, "agy-acp");
	fs.symlinkSync(actual, root);

	const result = cleanupManagedAcpInstall(root);

	assert.deepEqual(result.removedBuilds, []);
	assert.equal(fs.existsSync(path.join(actual, "agy_acp_server_1.1.1")), true);
});

test("cleanup recognizes the real registry layout and interrupted downloads", () => {
	const root = tmpDir();
	const build = managedBuild(root, "20260818_01_RC01");
	fs.writeFileSync(path.join(build, "args.json"), "[]\n");
	fs.writeFileSync(path.join(root, ".download-20260818_01_RC01.zip"), "partial");
	fs.symlinkSync(build, path.join(root, "current"));

	const result = cleanupManagedAcpInstall(root);

	assert.deepEqual(result.removedBuilds, ["20260818_01_RC01"]);
	assert.equal(result.rootRemoved, true);
	assert.equal(fs.existsSync(root), false);
});

test("cleanup removes an interrupted unpack with the harness marker but no checksum", () => {
	const root = tmpDir();
	const build = managedBuild(root, "partial-build");
	fs.rmSync(path.join(build, "zip.sha256"));
	fs.mkdirSync(path.join(build, "localharness_external"));

	const result = cleanupManagedAcpInstall(root);

	assert.deepEqual(result.removedBuilds, ["partial-build"]);
	assert.equal(result.rootRemoved, true);
});

test("concurrent cleanup of an already removed installation is harmless", () => {
	const root = tmpDir();
	managedBuild(root);
	cleanupManagedAcpInstall(root);
	assert.deepEqual(cleanupManagedAcpInstall(root), { removedBuilds: [], rootRemoved: false });
});

test("cleanup tolerates an absent install", () => {
	const result = cleanupManagedAcpInstall(path.join(tmpDir(), "absent"));
	assert.deepEqual(result, { removedBuilds: [], rootRemoved: false });
});
