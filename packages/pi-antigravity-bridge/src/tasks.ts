// Read-only task dashboard over one agy conversation's background tasks
// (.system_generated/tasks/task-<N>.log under the brain dir).
//
// WATCH-ONLY by design. The stream RPC never reports agy's background
// tasks, so visibility comes from this filesystem scan; liveness comes
// from one batched lsof call over every log path (per-file lsof would
// fork-storm). Ownership is deliberately NOT resolved: modern agy pipes
// task output through itself, so the process holding a log open proves
// nothing about which spawned job it is, and we never kill what we cannot
// prove we own. A task is "active" while any process holds its log open
// (a reader counts too — cat/less/tail -f will light it up; the dashboard
// is a watch, not a fact), "idle" otherwise; when lsof is missing,
// liveness is unknown and the dashboard says so instead of guessing.

import { readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { readTranscriptTail } from "./parked-turn.js";

const TASK_LOG_RE = /^task-(\d+)\.log$/;
const MAX_TASKS = 128;
const LSOFT_TIMEOUT_MS = 5_000;
const LSOFT_CAP_BYTES = 1024 * 1024;
export const TASK_TAIL_BYTES = 2 * 1024;

export interface AgyTask {
	id: number;
	logPath: string;
	bytes: number;
	modifiedMs: number;
	/** Any process currently holds the log open. */
	active: boolean;
	/** false when lsof is unavailable (liveness could not be checked). */
	livenessKnown: boolean;
}

/** Scan task logs under one conversation dir. Missing dirs return []
 *  (tasks are created on demand). Newest activity first, capped. */
export async function scanAgyTasks(conversationDir: string): Promise<AgyTask[]> {
	const dir = path.join(conversationDir, ".system_generated", "tasks");
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const tasks: AgyTask[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const match = TASK_LOG_RE.exec(entry.name);
		if (!match) continue;
		const logPath = path.join(dir, entry.name);
		try {
			const stats = await stat(logPath);
			tasks.push({
				id: Number(match[1]),
				logPath,
				bytes: stats.size,
				modifiedMs: stats.mtimeMs,
				active: false,
				livenessKnown: false,
			});
		} catch {
			continue; // vanished mid-scan
		}
	}
	tasks.sort((a, b) => b.modifiedMs - a.modifiedMs || b.id - a.id);
	return tasks.slice(0, MAX_TASKS);
}

/** Parse `lsof -nP -Fpn` output into path -> pids holding it open.
 *  Format: `p<PID>` starts a process block; `n<PATH>` marks a file of the
 *  current process. Pure; exported for tests.
 *  Known gap: a log unlinked while held open gets an "n<path> (deleted)"
 *  line whose key never equals the scanned path, so that holder is
 *  invisible and the task reads idle. Left as-is: stripping the suffix
 *  would attribute a rotation survivor to the REPLACEMENT file at the
 *  same path, which is a worse lie. */
export function parseLsofOwners(output: string): Map<string, Set<number>> {
	const owners = new Map<string, Set<number>>();
	let pid: number | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) {
			const parsed = Number(line.slice(1));
			pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
			continue;
		}
		if (!line.startsWith("n")) continue;
		if (pid === undefined) continue;
		const filePath = line.slice(1);
		if (!filePath) continue;
		let set = owners.get(filePath);
		if (!set) owners.set(filePath, (set = new Set()));
		set.add(pid);
	}
	return owners;
}

type SpawnRaw = (cmd: string, args: string[], timeoutMs: number, capBytes: number) => Promise<string>;

/** One batched lsof over every task log. Resolves undefined when lsof is
 *  missing or failed (spawn error / timeout); resolves "" when lsof ran
 *  and nothing is open (its normal exit-1-empty answer). */
async function lsofOwners(
	logPaths: string[],
	spawnRaw: SpawnRaw = defaultSpawnRaw,
): Promise<string | undefined> {
	if (logPaths.length === 0) return "";
	try {
		return await spawnRaw("lsof", ["-nP", "-Fpn", ...logPaths], LSOFT_TIMEOUT_MS, LSOFT_CAP_BYTES);
	} catch {
		return undefined;
	}
}

async function defaultSpawnRaw(
	cmd: string,
	args: string[],
	timeoutMs: number,
	capBytes: number,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		let settled = false;
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			done(() => reject(new Error(`${cmd} timed out`)));
		}, timeoutMs);
		child.stdout.on("data", (d: Buffer) => {
			if (out.length + d.length > capBytes) {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
				done(() => reject(new Error(`${cmd} output cap exceeded`)));
				return;
			}
			out += d.toString("utf8");
		});
		child.on("error", (err) => done(() => reject(err)));
		child.on("close", () => done(() => resolve(out)));
	});
}

/** Scan plus liveness in one call. Never throws; a missing or failed lsof
 *  leaves livenessKnown false rather than guessing. */
export async function listAgyTasks(
	conversationDir: string,
	spawnRaw?: SpawnRaw,
): Promise<AgyTask[]> {
	const tasks = await scanAgyTasks(conversationDir);
	if (tasks.length === 0) return tasks;
	const rawOwners = await lsofOwners(tasks.map((t) => t.logPath), spawnRaw);
	const owners = rawOwners === undefined ? undefined : parseLsofOwners(rawOwners);
	for (const task of tasks) {
		task.livenessKnown = owners !== undefined;
		task.active = (owners?.get(task.logPath)?.size ?? 0) > 0;
	}
	return tasks;
}

/** Last bytes of a task log for the tail command. Empty string on any
 *  error — tails are best-effort views, not facts. */
export async function tailAgyTaskLog(logPath: string): Promise<string> {
	return readTranscriptTail(logPath, TASK_TAIL_BYTES);
}
