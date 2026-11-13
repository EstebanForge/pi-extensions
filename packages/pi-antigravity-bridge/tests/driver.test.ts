// H1 regression: stream-json frames that split across pipe chunks must be
// buffered and reassembled, not dropped. Drives StreamDriver against the fake
// agy in tests/helpers/fake-agy-bin/agy (resolved via PATH), whose reply is
// deliberately split across two stdout writes mid-line.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, test } from "vitest";
import { StreamDriver, waitForPidGroupExit } from "../src/driver.js";
import type { DriverActivity } from "../src/driver-types.js";

const FAKE_BIN_DIR = path.join(import.meta.dirname, "helpers", "fake-agy-bin");

describe("stream-json driver stdout framing (H1)", () => {
	test("frames split across pipe chunks are reassembled", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "hi",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		const activities: DriverActivity[] = [];
		const collecting = (async () => {
			for (;;) {
				const activity = await handle.next();
				if (activity === null) return;
				activities.push(activity);
			}
		})();
		const outcome = await handle.outcome;
		await collecting;

		// Pre-fix, the split agent_response frame was dropped whole and the
		// response fell back to the result body ("RESULT-BODY").
		assert.equal(outcome.status, "OK");
		assert.equal(outcome.conversationId, "conv-777");
		assert.equal(outcome.response, "HALF-ONE-HALF-TWO");
		const text = activities
			.filter(
				(a): a is Extract<DriverActivity, { type: "text" }> =>
					a.type === "text",
			)
			.map((a) => a.delta)
			.join("");
		assert.equal(text, "HALF-ONE-HALF-TWO");
	});
});

describe("stream-json driver frame ceiling", () => {
	test("a no-newline flood over the frame cap fails the turn instead of buffering forever", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "OVERFLOW-FLOOD",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.match(outcome.error ?? "", /frame overflow/i);
	}, 30_000);
});

describe("stream-json driver stdout noise guard", () => {
	test("a noise line and a glued noise fragment do not corrupt the turn", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "NOISE-GLUE",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "OK");
		assert.equal(outcome.conversationId, "conv-noise");
		assert.equal(outcome.response, "AFTER-NOISE");
	});
});

describe("stream-json driver shutdown latch", () => {
	// Parity with the ACP driver fix: pi fires session_shutdown on /new,
	// /resume and /fork, so a closed driver must respawn on the next turn
	// instead of rejecting forever (regression 2026-09-07).
	test("a turn after close('shutdown') respawns instead of rejecting forever", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const opts = {
			prompt: "hi",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits" as const,
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		};
		const h1 = await driver.run(opts);
		assert.equal((await h1.outcome).status, "OK");

		await driver.close("shutdown");

		const h2 = await driver.run(opts);
		const o2 = await h2.outcome;
		assert.equal(o2.status, "OK");
		assert.equal(o2.error, undefined);
	});

	test("close('recycle') mid-turn settles the turn with a clean error", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "please HANG",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 10,
			inactivityMin: 10,
		});
		for (let i = 0; i < 80 && driver.state !== "running"; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.equal(
			driver.state,
			"running",
			"turn should be running before the recycle",
		);
		driver.close("recycle", "session switch");
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.match(outcome.error ?? "", /recycled mid-turn \(session switch\)/);
	});
});

describe("stream-json driver zero timeouts disable both caps", () => {
	test("timeoutMin/inactivityMin 0 keep a hung turn running", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "HANG",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0,
			inactivityMin: 0,
		});
		// A missing guard arms setTimeout(fn, 0) and settles the turn as ERROR
		// inside this window; the skipped caps leave it running.
		const raced = await Promise.race([
			handle.outcome.then((o) => o.status),
			new Promise<"running">((r) => setTimeout(() => r("running"), 400)),
		]);
		assert.equal(raced, "running");
		await driver.close("shutdown");
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "ERROR");
	});
});

describe("stream-json driver issue-#2 evidence fields", () => {
	test("a silent over-cap drop (SUCCESS, no steps, zero usage) reports modelOutputSeen=false", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "SILENT-DROP",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "OK");
		assert.equal(outcome.sawResult, true);
		assert.equal(outcome.modelOutputSeen, false);
		await driver.close("shutdown");
	});

	test("a real text turn reports modelOutputSeen=true and sawResult=true", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "hi",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "OK");
		assert.equal(outcome.sawResult, true);
		assert.equal(outcome.modelOutputSeen, true);
		await driver.close("shutdown");
	});

	test("a deadline stall with no result frame sets deadline and sawResult=false", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "please HANG",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 10,
			inactivityMin: 0.05,
		});
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.equal(outcome.sawResult, false);
		assert.equal(outcome.deadline, "stall");
		await driver.close("shutdown");
	}, 30_000);
});

describe("stream-json driver overall-cap pause on parks", () => {
	// The overall cap (timeoutMin) is a turn deadline, not an inactivity
	// guard: pi-tool time (G9 parks) and human-gated time must not consume
	// it, matching the ACP driver's remaining-budget semantics. Pre-fix the
	// timer was armed once and cleared only at settle, so a parked call ate
	// the turn cap.
	test("a park suspends the overall cap and the remaining budget resumes on unpark", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "please HANG",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.03, // ~1.8s cap
			inactivityMin: 0, // only the overall cap can fire
		});
		for (let i = 0; i < 80 && driver.state !== "running"; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.equal(driver.state, "running");
		driver.activeHandle?.pushExternal({
			type: "bridge_call",
			callId: "c1",
			name: "AskClaude",
			args: {},
		});
		// Outlive the cap while parked: pre-fix this fires "timeout".
		await new Promise((r) => setTimeout(r, 2500));
		const raced = await Promise.race([
			handle.outcome.then((o) => o.status),
			new Promise<"running">((r) => setTimeout(() => r("running"), 500)),
		]);
		assert.equal(
			raced,
			"running",
			"the overall cap must not fire while parked",
		);
		driver.kickIdle();
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.equal(outcome.deadline, "timeout");
		assert.match(outcome.error ?? "", /turn timeout/);
		await driver.close("shutdown");
	}, 30_000);

	test("without a park the overall cap still fires", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "please HANG",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.02, // ~1.2s cap
			inactivityMin: 0,
		});
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.equal(outcome.deadline, "timeout");
		await driver.close("shutdown");
	}, 30_000);

	test("a disabled cap (0) stays disabled across a park cycle", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "please HANG",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0,
			inactivityMin: 0,
		});
		for (let i = 0; i < 80 && driver.state !== "running"; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		driver.activeHandle?.pushExternal({
			type: "bridge_call",
			callId: "c1",
			name: "AskClaude",
			args: {},
		});
		await new Promise((r) => setTimeout(r, 400));
		driver.kickIdle();
		await new Promise((r) => setTimeout(r, 400));
		const raced = await Promise.race([
			handle.outcome.then((o) => o.status),
			new Promise<"running">((r) => setTimeout(() => r("running"), 100)),
		]);
		assert.equal(raced, "running");
		await driver.close("shutdown");
		assert.equal((await handle.outcome).status, "ERROR"); // shutdown close, not a cap
	}, 30_000);
});

describe("stream-json driver stderr redaction", () => {
	// Regression (peer review 2026-09): the raw stderr tail rode verbatim into
	// the turn-failure message (user transcript + daily log). A secret agy
	// printed to stderr must come out redacted.
	test("a secret in agy stderr never reaches the turn error", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "STDERR-LEAK",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.ok(outcome.error);
		assert.equal(outcome.error.includes("AIzaSyA"), false, "raw secret absent");
		assert.ok(outcome.error.includes("<redacted>"), "secret is redacted");
		await driver.close("shutdown");
	});
});

describe("stream-json driver plan-mode skip-permission gating", () => {
	// The skip-permissions flag is never passed in plan mode (it would
	// auto-approve plan mode's own approval gate). #recycleCause compares
	// the stored EFFECTIVE value, so two identical plan-mode requests must
	// reuse the process; comparing effective vs raw recycled every turn.
	test("two identical plan-mode turns reuse the process", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const base = {
			prompt: "KEEP-ALIVE",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "plan" as const,
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		};
		const first = await driver.run(base);
		const firstOutcome = await first.outcome;
		assert.equal(firstOutcome.status, "OK");
		assert.equal(firstOutcome.conversationId, "conv-777");
		const second = await driver.run({
			...base,
			conversationId: firstOutcome.conversationId,
		});
		const secondOutcome = await second.outcome;
		assert.equal(secondOutcome.status, "OK");
		const stats = driver.snapshot().stats;
		assert.equal(stats.recycles, 0, "plan turns must not recycle");
		assert.equal(stats.reused, 1, "second plan turn reuses the process");
		assert.equal(stats.spawns, 1, "one process serves both turns");
		await driver.close("shutdown");
	});

	test("a raw knob flip stays invisible in plan mode", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const first = await driver.run({
			prompt: "KEEP-ALIVE",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "plan",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		const firstOutcome = await first.outcome;
		assert.equal(firstOutcome.status, "OK");
		const second = await driver.run({
			prompt: "KEEP-ALIVE",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "plan",
			skipPermissions: false,
			conversationId: firstOutcome.conversationId,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		await second.outcome;
		const stats = driver.snapshot().stats;
		assert.equal(
			stats.recycles,
			0,
			"raw knob flip stays invisible in plan mode (effective unchanged)",
		);
		await driver.close("shutdown");
	});

	test("StreamDriver strips <SYSTEM_MESSAGE> blocks from streamed deltas", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const handle = await driver.run({
			prompt: "SYSTEM-MESSAGE",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		const activities: DriverActivity[] = [];
		const collecting = (async () => {
			for (;;) {
				const activity = await handle.next();
				if (activity === null) return;
				activities.push(activity);
			}
		})();
		const outcome = await handle.outcome;
		await collecting;

		assert.equal(outcome.status, "OK");
		assert.equal(outcome.response, "Real reply");
		const text = activities
			.filter(
				(a): a is Extract<DriverActivity, { type: "text" }> =>
					a.type === "text",
			)
			.map((a) => a.delta)
			.join("");
		assert.equal(text, "Real reply");
		await driver.close("shutdown");
	});
});

// --- isolated MCP home (issue #14) -------------------------------------------

describe("stream-json driver isolated home", () => {
	test("the spawn argv carries the staged home via --gemini_dir", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-driver-flag-"));
		driver.stagedHome = () => home;
		try {
			const handle = await driver.run({
				prompt: "HOME-MARKER",
				cwd: process.cwd(),
				model: "gemini-3.8-flash",
				mode: "accept-edits",
				skipPermissions: true,
				timeoutMin: 0.5,
				inactivityMin: 0.5,
			});
			const outcome = await handle.outcome;
			assert.equal(outcome.status, "OK");
			// The fake agy echoes the home basename back as the conversation id:
			// proof the flag actually reached the child process.
			assert.equal(outcome.conversationId, `home-${path.basename(home)}`);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
		await driver.close("shutdown");
	});

	test("close disposes the staged home exactly once, on recycle and shutdown", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-driver-close-"));
		driver.stagedHome = () => home;
		const releases: Array<{ home: string; pid: number | undefined }> = [];
		driver.releaseStagedHome = (h, pid) => {
			releases.push({ home: h, pid });
		};
		const handle = await driver.run({
			prompt: "hi",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		await handle.outcome;
		await driver.close("recycle", "test");
		assert.equal(releases.length, 1);
		assert.equal(releases[0]?.home, home);
		assert.equal(typeof releases[0]?.pid, "number");
		// No child and no staged home left: a second close must not re-release.
		await driver.close("shutdown");
		assert.equal(releases.length, 1);
		fs.rmSync(home, { recursive: true, force: true });
	});

	test("a mid-turn deadline kill keeps the home for the next spawn", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-driver-stall-"));
		driver.stagedHome = () => home;
		let releases = 0;
		driver.releaseStagedHome = () => {
			releases += 1;
		};
		const handle = await driver.run({
			prompt: "HANG",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.05,
		});
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.equal(releases, 0, "deadline kill must not dispose the home");
		// The next turn respawns into a FRESH home: the recycle close first
		// disposes the stale one (dead child), then stagedHome() restages.
		const second = await driver.run({
			prompt: "hi",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		assert.equal((await second.outcome).status, "OK");
		await driver.close("shutdown");
		// One release for the post-deadline recycle restage, one for shutdown.
		assert.equal(releases, 2);
		fs.rmSync(home, { recursive: true, force: true });
	}, 15_000);

	test("close with an ALREADY-DEAD child still disposes the staged home", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new StreamDriver();
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-driver-dead-"));
		driver.stagedHome = () => home;
		let releases = 0;
		driver.releaseStagedHome = () => {
			releases += 1;
		};
		const handle = await driver.run({
			// Plain prompt: the fake agy exits after the result, so by the time
			// close() runs the child is gone and #child is undefined - the exact
			// path where an early return would leak the home.
			prompt: "hi",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		await handle.outcome;
		// The fake exits ~200ms after the result frame; wait past that so the
		// driver's exit handler has cleared #child before close runs.
		await new Promise((r) => setTimeout(r, 600));
		await driver.close("recycle", "test");
		assert.equal(releases, 1, "close must release the home even with no live child");
		fs.rmSync(home, { recursive: true, force: true });
	});

	test("waitForPidGroupExit: dead group resolves immediately, live group times out", async () => {
		const dead = spawn("sleep", ["5"], { detached: true, stdio: "ignore" });
		dead.unref();
		const deadPid = dead.pid!;
		try {
			process.kill(-deadPid, "SIGKILL");
		} catch {
			/* already gone */
		}
		assert.equal(await waitForPidGroupExit(deadPid, 2000), true);

		const live = spawn("sleep", ["2"], { detached: true, stdio: "ignore" });
		live.unref();
		try {
			assert.equal(await waitForPidGroupExit(live.pid!, 150), false);
		} finally {
			try {
				process.kill(-live.pid!, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	});
});
