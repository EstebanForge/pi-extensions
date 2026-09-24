// Unit tests for the task dashboard (src/tasks.ts). Filesystem behavior
// runs against real temp dirs; the lsof call is faked at the spawn seam.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	listAgyTasks,
	parseLsofOwners,
	scanAgyTasks,
	tailAgyTaskLog,
	type AgyTask,
} from "../src/tasks.js";

function tmpConversation(tasks: Array<{ id: number; bytes?: number; mtimeMs?: number }>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tasks-"));
	const taskDir = path.join(dir, ".system_generated", "tasks");
	fs.mkdirSync(taskDir, { recursive: true });
	for (const t of tasks) {
		const file = path.join(taskDir, `task-${t.id}.log`);
		fs.writeFileSync(file, Buffer.alloc(t.bytes ?? 10));
		if (t.mtimeMs !== undefined) fs.utimesSync(file, new Date(t.mtimeMs), new Date(t.mtimeMs));
	}
	return dir;
}

// --- scanAgyTasks ------------------------------------------------------------

test("scanAgyTasks: ids parsed, foreign files ignored, newest first with id tiebreak", async () => {
	const dir = tmpConversation([
		{ id: 1, mtimeMs: 1000 },
		{ id: 2, mtimeMs: 3000 },
		{ id: 10, mtimeMs: 3000 },
	]);
	try {
		fs.writeFileSync(path.join(dir, ".system_generated", "tasks", "task-x.log"), "nope");
		fs.writeFileSync(path.join(dir, ".system_generated", "tasks", "notes.md"), "nope");
		fs.mkdirSync(path.join(dir, ".system_generated", "tasks", "task-99.log"));
		const tasks = await scanAgyTasks(dir);
		assert.deepEqual(tasks.map((t) => t.id), [10, 2, 1]); // tie on mtime -> higher id first
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("scanAgyTasks: missing dir and cap behavior", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tasks-empty-"));
	try {
		assert.deepEqual(await scanAgyTasks(path.join(dir, "nope")), []);
		const many = tmpConversation(Array.from({ length: 130 }, (_, i) => ({ id: i, mtimeMs: i })));
		try {
			assert.equal((await scanAgyTasks(many)).length, 128);
		} finally {
			fs.rmSync(many, { recursive: true, force: true });
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// --- parseLsofOwners ---------------------------------------------------------

test("parseLsofOwners: -Fpn blocks map paths to holder pids", () => {
	// n lines carry the absolute path verbatim after the leading n.
	const owners = parseLsofOwners(
		["p123", "n/tmp/a.log", "n/tmp/b.log", "p456", "n/tmp/a.log", "p0", "n/tmp/skip.log", "n", ""].join("\n"),
	);
	assert.deepEqual([...owners.get("/tmp/a.log") ?? []].sort(), [123, 456]);
	assert.deepEqual([...owners.get("/tmp/b.log") ?? []], [123]);
	assert.equal(owners.has("/tmp/skip.log"), false); // p0 is not a valid pid block
	assert.equal(owners.has(""), false);
});

// --- listAgyTasks ------------------------------------------------------------

test("listAgyTasks: lsof ran -> liveness known, held log is ACTIVE", async () => {
	const dir = tmpConversation([{ id: 1, mtimeMs: 2000 }, { id: 2, mtimeMs: 1000 }]);
	try {
		const log1 = path.join(dir, ".system_generated", "tasks", "task-1.log");
		const lsofOut = `p4242\nn${log1}\n`;
		const spawnRaw = async (cmd: string, args: string[]) => {
			assert.equal(cmd, "lsof");
			assert.ok(args.includes(log1));
			assert.ok(args.includes(path.join(dir, ".system_generated", "tasks", "task-2.log")));
			return lsofOut;
		};
		const tasks = await listAgyTasks(dir, spawnRaw);
		assert.deepEqual(tasks.map((t) => [t.id, t.active, t.livenessKnown]), [
			[1, true, true],
			[2, false, true],
		]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("listAgyTasks: lsof ran with empty output -> all idle, still known", async () => {
	const dir = tmpConversation([{ id: 1 }]);
	try {
		const tasks = await listAgyTasks(dir, async () => "");
		assert.deepEqual(tasks.map((t) => [t.active, t.livenessKnown]), [[false, true]]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("listAgyTasks: lsof missing -> liveness unknown, never active", async () => {
	const dir = tmpConversation([{ id: 1 }]);
	try {
		const tasks = await listAgyTasks(dir, async () => {
			throw new Error("ENOENT");
		});
		assert.deepEqual(tasks.map((t) => [t.active, t.livenessKnown]), [[false, false]]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("listAgyTasks: no tasks -> no lsof spawned", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tasks-none-"));
	try {
		const tasks = await listAgyTasks(dir, async () => {
			throw new Error("must not spawn");
		});
		assert.deepEqual(tasks, [] satisfies AgyTask[]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// --- tailAgyTaskLog ----------------------------------------------------------

test("tailAgyTaskLog: last bytes only, missing file empty", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tail-"));
	try {
		const file = path.join(dir, "task-7.log");
		fs.writeFileSync(file, "x".repeat(5000) + "THE-END");
		const tail = await tailAgyTaskLog(file);
		assert.ok(tail.endsWith("THE-END"));
		assert.ok(tail.length <= 2048);
		assert.equal(await tailAgyTaskLog(path.join(dir, "nope")), "");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
