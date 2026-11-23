// Unit tests for SessionStore load-time narrowing (src/sessions.ts).
//
// Proves a corrupt or hand-edited sessions.json can't plant wrong-typed fields
// into the cache: malformed entries are dropped and bad lastStepIdx values fall
// back to -1. Written as raw JSON text (not JSON.stringify) so the 1e999 token
// survives as Infinity through JSON.parse.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { SessionStore } from "../src/sessions.js";

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-sessions-")), "sessions.json");
}

test("SessionStore: missing file starts empty (no throw)", () => {
	const store = new SessionStore(tmpStorePath());
	assert.equal(store.size, 0);
	assert.equal(store.get("anything"), null);
});

test("SessionStore: load drops malformed entries, keeps valid ones", () => {
	const p = tmpStorePath();
	fs.writeFileSync(
		p,
		JSON.stringify({
			good: { conversationId: "abc-123", lastStepIdx: 5 },
			badId: { conversationId: 123, lastStepIdx: 2 }, // id not a string -> drop
			badIdx: { conversationId: "xyz", lastStepIdx: "no" }, // idx not a number -> keep, -1
			nonObj: "string-value", // not an object -> drop
			missing: { lastStepIdx: 3 }, // no conversationId -> drop
		}) + "\n",
	);
	const store = new SessionStore(p);
	assert.deepEqual(store.get("good"), { conversationId: "abc-123", lastStepIdx: 5, lastMessageCount: 0 });
	assert.equal(store.get("badId"), null);
	assert.deepEqual(store.get("badIdx"), { conversationId: "xyz", lastStepIdx: -1, lastMessageCount: 0 });
	assert.equal(store.get("nonObj"), null);
	assert.equal(store.get("missing"), null);
});

test("SessionStore: non-finite lastStepIdx (Infinity from 1e999) falls back to -1", () => {
	const p = tmpStorePath();
	// Raw text: 1e999 parses to Infinity, which Number.isFinite rejects.
	fs.writeFileSync(p, `{"huge": {"conversationId": "big", "lastStepIdx": 1e999}}\n`);
	const store = new SessionStore(p);
	assert.deepEqual(store.get("huge"), { conversationId: "big", lastStepIdx: -1, lastMessageCount: 0 });
});

test("SessionStore: set/get round-trip in memory (incl. lastMessageCount watermark)", () => {
	const store = new SessionStore(tmpStorePath());
	store.set("k", { conversationId: "c-1", lastStepIdx: 9, lastMessageCount: 42 });
	assert.deepEqual(store.get("k"), { conversationId: "c-1", lastStepIdx: 9, lastMessageCount: 42 });
	assert.equal(store.size, 1);
});

test("SessionStore: digest bookkeeping survives a reload (fingerprint + compaction index)", async () => {
	const p = tmpStorePath();
	const store = new SessionStore(p);
	store.set("k", {
		conversationId: "c-1",
		lastStepIdx: -1,
		lastMessageCount: 3,
		digestBoundary: "user:1700000000000",
		digestSummaryId: "8301:ff2a91c7",
	});
	// The write is queued; wait for it to land before a fresh instance reads.
	await vi.waitFor(() => {
		JSON.parse(fs.readFileSync(p, "utf8"));
	});
	const reloaded = new SessionStore(p);
	assert.deepEqual(reloaded.get("k"), {
		conversationId: "c-1",
		lastStepIdx: -1,
		lastMessageCount: 3,
		digestBoundary: "user:1700000000000",
		digestSummaryId: "8301:ff2a91c7",
	});
});

test("SessionStore: top-level non-object file is treated as empty", () => {
	const p = tmpStorePath();
	fs.writeFileSync(p, `[1, 2, 3]`); // array, not an object
	const store = new SessionStore(p);
	assert.equal(store.size, 0);
});

test("SessionStore: delete drops only the target key, in memory and on disk", async () => {
	const p = tmpStorePath();
	const store = new SessionStore(p);
	store.set("a", { conversationId: "conv-a", lastStepIdx: 1, lastMessageCount: 5 });
	store.set("b", { conversationId: "conv-b", lastStepIdx: 2, lastMessageCount: 7 });
	store.delete("a");
	assert.equal(store.get("a"), null);
	assert.equal(store.get("b")?.conversationId, "conv-b");
	assert.equal(store.size, 1);
	// persist() overlays dirty keys on the on-disk state; the deleted key must
	// not resurrect from it.
	await vi.waitFor(() => {
		const disk = JSON.parse(fs.readFileSync(p, "utf8"));
		assert.ok(!("a" in disk), "deleted key must not persist");
		assert.equal(disk.b?.conversationId, "conv-b");
	});
});

test("SessionStore: set after delete resurrects the key", async () => {
	const p = tmpStorePath();
	const store = new SessionStore(p);
	store.set("k", { conversationId: "c-1", lastStepIdx: 0, lastMessageCount: 3 });
	store.delete("k");
	store.set("k", { conversationId: "c-2", lastStepIdx: -1, lastMessageCount: 0 });
	assert.deepEqual(store.get("k"), { conversationId: "c-2", lastStepIdx: -1, lastMessageCount: 0 });
	await vi.waitFor(() => {
		const disk = JSON.parse(fs.readFileSync(p, "utf8"));
		assert.equal(disk.k?.conversationId, "c-2");
	});
});

test("SessionStore: a removed key stops being deleted once its persist lands (multi-process)", async () => {
	const p = tmpStorePath();
	const store = new SessionStore(p);
	store.set("a", { conversationId: "conv-a", lastStepIdx: 0, lastMessageCount: 1 });
	store.delete("a");
	await vi.waitFor(() => {
		const disk = JSON.parse(fs.readFileSync(p, "utf8"));
		assert.ok(!("a" in disk), "delete must land first");
	});
	// Another process reclaims the key (the cwd-fallback key is shared across
	// pi processes in one directory). Our NEXT unrelated persist must honor
	// its write, not replay our stale deletion.
	fs.writeFileSync(
		p,
		JSON.stringify({ a: { conversationId: "conv-other-process", lastStepIdx: 3, lastMessageCount: 9 } }) + "\n",
	);
	store.set("b", { conversationId: "conv-b", lastStepIdx: 0, lastMessageCount: 2 });
	await vi.waitFor(() => {
		const disk = JSON.parse(fs.readFileSync(p, "utf8"));
		assert.equal(disk.a?.conversationId, "conv-other-process", "unrelated persist must not re-delete a reclaimed key");
		assert.equal(disk.b?.conversationId, "conv-b");
	});
});

test("flush resolves only after queued sets and deletes reach disk", async () => {
	const p = tmpStorePath();

	const store = new SessionStore(p);
	store.set("sid:a", { conversationId: "conv-a", lastStepIdx: -1, lastMessageCount: 1 });
	store.set("sid:b", { conversationId: "conv-b", lastStepIdx: 2, lastMessageCount: 4 });
	store.delete("sid:a");

	await store.flush();

	const disk = JSON.parse(fs.readFileSync(p, "utf8"));
	assert.equal(disk["sid:a"], undefined);
	assert.equal(disk["sid:b"]?.conversationId, "conv-b");
});
