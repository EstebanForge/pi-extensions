// Unit tests for the artifact scan (src/artifacts.ts) and the brain-dir
// helper (src/agy-paths.ts). Filesystem behavior is exercised against real
// temp dirs: media mapping, skip rules, symlink rejection, missing-dir
// tolerance, newest-first ordering. UI is not unit-tested (same policy as
// the engine picker).
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { artifactOpenCommand, listAgyArtifacts } from "../src/artifacts.js";
import { agyBrainRoot, agyConversationDir } from "../src/agy-paths.js";

function tmpConversation(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-artifacts-"));
}

function touch(dir: string, name: string, bytes = 10, mtimeMs?: number): string {
	const p = path.join(dir, name);
	fs.writeFileSync(p, Buffer.alloc(bytes));
	if (mtimeMs !== undefined) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
	return p;
}

// --- agy-paths ---------------------------------------------------------------

test("agyBrainRoot: per-engine scope, raw conversation id joins", () => {
	const home = os.tmpdir();
	assert.equal(agyBrainRoot("stream-json", home), path.join(home, ".gemini", "antigravity-cli", "brain"));
	assert.equal(agyBrainRoot("acp", home), path.join(home, ".gemini", "antigravity-acp", "brain"));
	assert.equal(
		agyConversationDir("acp", "36373b4d-1234", home),
		path.join(home, ".gemini", "antigravity-acp", "brain", "36373b4d-1234"),
	);
});

// --- listAgyArtifacts --------------------------------------------------------

test("listAgyArtifacts: media map, skip rules, kind tagging", async () => {
	const dir = tmpConversation();
	try {
		touch(dir, "photo.png");
		touch(dir, "notes.md");
		touch(dir, "clip.mp4");
		touch(dir, "doc.pdf");
		touch(dir, "blob.xyz");
		touch(dir, ".hidden");
		touch(dir, "keep.metadata.json");
		const items = await listAgyArtifacts(dir);
		const names = items.map((a) => a.name);
		assert.ok(names.includes("photo.png"));
		assert.ok(names.includes("notes.md"));
		assert.ok(names.includes("clip.mp4"));
		assert.ok(names.includes("doc.pdf"));
		assert.ok(names.includes("blob.xyz"));
		assert.ok(!names.includes(".hidden"));
		assert.ok(!names.includes("keep.metadata.json"));
		const photo = items.find((a) => a.name === "photo.png");
		assert.equal(photo?.mediaType, "image");
		assert.equal(photo?.kind, "conversation");
		assert.equal(items.find((a) => a.name === "blob.xyz")?.mediaType, "other");
		assert.equal(items.find((a) => a.name === "notes.md")?.mediaType, "markdown");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("listAgyArtifacts: generated and uploaded kinds from subdirs", async () => {
	const dir = tmpConversation();
	try {
		fs.mkdirSync(path.join(dir, ".tempmediaStorage"));
		fs.mkdirSync(path.join(dir, ".user_uploaded"));
		touch(path.join(dir, ".tempmediaStorage"), "gen.png");
		touch(path.join(dir, ".user_uploaded"), "up.png");
		const items = await listAgyArtifacts(dir);
		assert.equal(items.find((a) => a.name === "gen.png")?.kind, "generated");
		assert.equal(items.find((a) => a.name === "up.png")?.kind, "uploaded");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("listAgyArtifacts: missing dirs are tolerated, missing root is empty", async () => {
	const dir = tmpConversation();
	try {
		// No media subdirs at all.
		touch(dir, "a.txt");
		assert.equal((await listAgyArtifacts(dir)).length, 1);
		// No conversation dir.
		assert.deepEqual(await listAgyArtifacts(path.join(dir, "does-not-exist")), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("listAgyArtifacts: symlinks are excluded, even in-root", async () => {
	const dir = tmpConversation();
	try {
		touch(dir, "real.txt");
		fs.symlinkSync("real.txt", path.join(dir, "link.txt"));
		// An escape attempt: symlink pointing outside the conversation root.
		const outside = path.join(os.tmpdir(), `agy-outside-${process.pid}.txt`);
		fs.writeFileSync(outside, "secret");
		fs.symlinkSync(outside, path.join(dir, "escape.txt"));
		const names = (await listAgyArtifacts(dir)).map((a) => a.name);
		assert.ok(names.includes("real.txt"));
		assert.ok(!names.includes("link.txt"));
		assert.ok(!names.includes("escape.txt"));
		fs.rmSync(outside, { force: true });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("listAgyArtifacts: newest first", async () => {
	const dir = tmpConversation();
	try {
		touch(dir, "old.png", 1, Date.now() - 60_000);
		touch(dir, "new.png", 1, Date.now());
		const items = await listAgyArtifacts(dir);
		assert.equal(items[0]?.name, "new.png");
		assert.equal(items[1]?.name, "old.png");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("listAgyArtifacts: reached through a symlinked ancestor still lists", async () => {
	// Pins the canonicalize-once fix: a raw-vs-canonical containment check
	// silently zeroes the scan when any ancestor is a symlink (macOS /var ->
	// /private/var, symlinked homes). The dir is scanned via an alias path.
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "agy-alias-"));
	const alias = path.join(base, "link");
	const realDir = path.join(base, "real", "conv");
	fs.mkdirSync(realDir, { recursive: true });
	fs.symlinkSync(path.join(base, "real"), alias);
	try {
		touch(realDir, "photo.png");
		fs.mkdirSync(path.join(realDir, ".user_uploaded"));
		touch(path.join(realDir, ".user_uploaded"), "up.png");
		const items = await listAgyArtifacts(path.join(alias, "conv"));
		const names = items.map((a) => a.name);
		assert.ok(names.includes("photo.png"), "root file missed through symlinked ancestor");
		assert.ok(names.includes("up.png"), "uploaded file missed through symlinked ancestor");
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

// --- artifactOpenCommand -----------------------------------------------------

test("artifactOpenCommand: darwin/linux mapped, others undefined", () => {
	const cmd = artifactOpenCommand();
	if (process.platform === "darwin") assert.equal(cmd?.cmd, "open");
	else if (process.platform === "linux") assert.equal(cmd?.cmd, "xdg-open");
	else assert.equal(cmd, undefined);
});
