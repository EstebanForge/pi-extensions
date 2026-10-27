// Unit tests for the stream-json prompt-image staging helper: user-attached
// image blocks cannot ride the CLI's text-only turn input, so they are staged
// to temp files and the prompt points the model at them (the bridge read tool
// then delivers the pixels as tool-result image content).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { STAGE_DIR_PREFIX, STAGE_MAX_AGE_MS, buildImageNote, stagePromptImages } from "../src/prompt-images.js";

const PNG = { data: Buffer.from("png-bytes-1").toString("base64"), mimeType: "image/png" };
const JPG = { data: Buffer.from("jpg-bytes-2").toString("base64"), mimeType: "image/jpeg" };

test("staging: writes decodable files with mime-derived extensions", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-imgstage-"));
	try {
		const staged = stagePromptImages([PNG, JPG], root);
		assert.ok(staged, "staging succeeded");
		assert.equal(staged.paths.length, 2);
		assert.deepEqual(fs.readFileSync(staged.paths[0]), Buffer.from("png-bytes-1"));
		assert.deepEqual(fs.readFileSync(staged.paths[1]), Buffer.from("jpg-bytes-2"));
		assert.match(staged.paths[0], /\.png$/);
		assert.match(staged.paths[1], /\.jpg$/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("staging: unknown mime falls back to .bin, files are user-private", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-imgstage-"));
	try {
		const staged = stagePromptImages([{ data: PNG.data, mimeType: "image/x-weird" }], root);
		assert.ok(staged);
		assert.match(staged.paths[0], /\.bin$/);
		assert.equal(fs.statSync(staged.paths[0]).mode & 0o077, 0, "no group/other access");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("sweep: stale staging dirs are removed, fresh and foreign dirs survive", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-imgstage-"));
	try {
		const stale = path.join(root, `${STAGE_DIR_PREFIX}stale`);
		const fresh = path.join(root, `${STAGE_DIR_PREFIX}fresh`);
		const foreign = path.join(root, "unrelated");
		fs.mkdirSync(stale);
		fs.mkdirSync(fresh);
		fs.mkdirSync(foreign);
		const old = new Date(Date.now() - STAGE_MAX_AGE_MS - 60_000);
		fs.utimesSync(stale, old, old);
		const staged = stagePromptImages([PNG], root);
		assert.ok(staged);
		assert.equal(fs.existsSync(stale), false, "stale dir swept");
		assert.equal(fs.existsSync(fresh), true, "fresh dir kept");
		assert.equal(fs.existsSync(foreign), true, "foreign dir kept");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("fail-closed: unusable root returns null instead of throwing", () => {
	// A regular file where a directory is needed: mkdtemp fails ENOTDIR.
	const notADir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-imgstage-")), "file");
	fs.writeFileSync(notADir, "x");
	assert.equal(stagePromptImages([PNG], notADir), null);
});

test("note: lists absolute paths and points at the bridge read tool", () => {
	const note = buildImageNote(["/tmp/x/image-1.png", "/tmp/x/image-2.jpg"]);
	assert.match(note, /\/tmp\/x\/image-1\.png/);
	assert.match(note, /\/tmp\/x\/image-2\.jpg/);
	assert.match(note, /read tool/i);
});
