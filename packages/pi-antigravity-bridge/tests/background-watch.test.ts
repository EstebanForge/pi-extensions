// Background-watch unit tests. Virtual clock: sleep() advances it, listTasks
// reads it, so every timing assertion is deterministic.
import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgyTask } from "../src/tasks.js";
import {
	armBackgroundWatch,
	buildTaskWakeContent,
	looksBackgroundNativeCall,
	rearmPlansFromEntries,
	type BackgroundWatchOptions,
} from "../src/background-watch.js";

interface VirtualClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

/** Sleep advances the virtual clock to the pending timer, so back-to-back
 *  polls run without real waits. One timer at a time (the watcher polls
 *  serially). */
function makeClock(): VirtualClock {
	let t = 0;
	return {
		now: () => t,
		sleep(ms: number) {
			t += ms;
			return Promise.resolve();
		},
	};
}

function task(overrides: Partial<AgyTask> = {}): AgyTask {
	return {
		id: 2,
		logPath: "/brain/conv/.system_generated/tasks/task-2.log",
		bytes: 100,
		modifiedMs: 0,
		active: false,
		livenessKnown: true,
		...overrides,
	};
}

type Scanner = () => Promise<AgyTask[]>;

/** finish() sets stopped BEFORE awaiting tails and sending the wake, so the
 *  drive loop can observe the stop while the wake is still in flight. Yield
 *  one macrotask before asserting. */
const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

function makeOpts(clock: VirtualClock, scanner: Scanner, wake: (content: string) => void): BackgroundWatchOptions {
	return {
		conversationId: "conv-1",
		conversationDir: "/brain/conv",
		turnStartMs: -60_000,
		listTasks: scanner,
		tail: async (logPath) => `tail of ${logPath}`,
		sendWake: wake,
		log: () => {},
		sleep: clock.sleep,
		now: clock.now,
	};
}

test("looksBackgroundNativeCall matches the probe-verified WaitMsBeforeAsync shape", () => {
	assert.equal(looksBackgroundNativeCall({ CommandLine: "sleep 45", WaitMsBeforeAsync: 500 }), true);
	assert.equal(looksBackgroundNativeCall({ CommandLine: "sleep 45", WaitMsBeforeAsync: 0 }), false);
	assert.equal(looksBackgroundNativeCall({ CommandLine: "sleep 45" }), false);
	assert.equal(looksBackgroundNativeCall({ WaitMsBeforeAsync: "500" }), false);
	assert.equal(looksBackgroundNativeCall({}), false);
});

test("watcher wakes once after the quiet window and stops", async () => {
	const clock = makeClock();
	const wakes: string[] = [];
	const settles: Array<{ outcome: string; taskIds: number[] }> = [];
	let polls = 0;
	// Active only on the first poll; stats never change after creation, so
	// settled = inactive AND unchanged across quietMs (30s = 6 polls at 5s).
	const scanner: Scanner = async () => {
		polls += 1;
		return [task({ active: polls <= 1, bytes: 100, modifiedMs: 0 })];
	};
	const watch = armBackgroundWatch({
		...makeOpts(clock, scanner, (c) => wakes.push(c)),
		onSettle: (r) => settles.push(r),
	});
	for (let i = 0; i < 12 && !watch.stopped; i++) {
		await clock.sleep(5_000);
	}
	await tick();
	assert.equal(watch.stopped, true);
	assert.equal(wakes.length, 1);
	assert.match(wakes[0]!, /no writer observed/);
	assert.match(wakes[0]!, /task-2/);
	assert.match(wakes[0]!, /tail of \/brain\/conv/);
	assert.deepEqual(settles, [{ outcome: "settled", taskIds: [2] }]);
});

test("watcher never says finished; wording is liveness-only", () => {
	const content = buildTaskWakeContent([{ id: 7, logPath: "/t/task-7.log", tailText: "done" }], "settled", 42);
	assert.doesNotMatch(content, /\bfinished\b/i);
	assert.match(content, /no writer observed/);
	assert.match(content, /UNTRUSTED/);
});

test("watcher caps and wakes with gave-up wording", async () => {
	const clock = makeClock();
	const wakes: string[] = [];
	const scanner: Scanner = async () => [task({ active: true })];
	const watch = armBackgroundWatch({ ...makeOpts(clock, scanner, (c) => wakes.push(c)), capMs: 60_000 });
	for (let i = 0; i < 40 && !watch.stopped; i++) {
		await clock.sleep(5_000);
	}
	await tick();
	assert.equal(watch.stopped, true);
	assert.equal(wakes.length, 1);
	assert.match(wakes[0]!, /gave up|stopped watching/);
	assert.match(wakes[0]!, /UNTRUSTED/);
});

test("spurious arm with no task logs stops silently without waking", async () => {
	const clock = makeClock();
	const wakes: string[] = [];
	const scanner: Scanner = async () => [];
	const watch = armBackgroundWatch(makeOpts(clock, scanner, (c) => wakes.push(c)));
	for (let i = 0; i < 12 && !watch.stopped; i++) {
		await clock.sleep(5_000);
	}
	assert.equal(watch.stopped, true);
	assert.equal(wakes.length, 0);
});

test("a task log appearing mid-watch joins the tracked set", async () => {
	const clock = makeClock();
	const wakes: string[] = [];
	let polls = 0;
	const scanner: Scanner = async () => {
		polls += 1;
		return polls < 3 ? [] : [task({ id: 9, active: false, bytes: 5, modifiedMs: 0 })];
	};
	const watch = armBackgroundWatch(makeOpts(clock, scanner, (c) => wakes.push(c)));
	for (let i = 0; i < 20 && !watch.stopped; i++) {
		await clock.sleep(5_000);
	}
	await tick();
	assert.equal(watch.stopped, true);
	assert.equal(wakes.length, 1);
	assert.match(wakes[0]!, /task-9/);
});

test("stop() mid-flight wakes nobody", async () => {
	const clock = makeClock();
	const wakes: string[] = [];
	const scanner: Scanner = async () => [task({ active: true })];
	const watch = armBackgroundWatch(makeOpts(clock, scanner, (c) => wakes.push(c)));
	watch.stop();
	watch.stop();
	await clock.sleep(100_000);
	assert.equal(watch.stopped, true);
	assert.equal(wakes.length, 0);
});

test("a growing log never settles on liveness-unknown alone; cap catches it", async () => {
	const clock = makeClock();
	const wakes: string[] = [];
	let polls = 0;
	const scanner: Scanner = async () => {
		polls += 1;
		return [task({ active: false, livenessKnown: false, bytes: polls * 10, modifiedMs: 0 })];
	};
	const watch = armBackgroundWatch({ ...makeOpts(clock, scanner, (c) => wakes.push(c)), capMs: 45_000 });
	for (let i = 0; i < 20 && !watch.stopped; i++) {
		await clock.sleep(5_000);
	}
	await tick();
	assert.equal(watch.stopped, true);
	assert.equal(wakes.length, 1);
	assert.match(wakes[0]!, /gave up|stopped watching/);
});

test("rearmPlansFromEntries plans only armed-without-settled records", () => {
	const plans = rearmPlansFromEntries([
		{ customType: "agy-background-watch", data: { kind: "armed", conversationId: "c1", turnStartMs: 10, armedAt: 100 } },
		{ customType: "agy-background-watch", data: { kind: "settled", conversationId: "c1", armedAt: 100, settledAt: 200, taskIds: [2] } },
		{ customType: "agy-background-watch", data: { kind: "armed", conversationId: "c2", turnStartMs: 20, armedAt: 300 } },
		{ customType: "unrelated", data: { kind: "armed", conversationId: "c3", turnStartMs: 30, armedAt: 400 } },
	]);
	assert.deepEqual(plans, [{ conversationId: "c2", turnStartMs: 20, armedAt: 300 }]);
});
