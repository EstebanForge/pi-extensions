// H1 regression: stream-json frames that split across pipe chunks must be
// buffered and reassembled, not dropped. Drives StreamDriver against the fake
// agy in tests/helpers/fake-agy-bin/agy (resolved via PATH), whose reply is
// deliberately split across two stdout writes mid-line.

import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { StreamDriver } from "../src/driver.js";
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
			.filter((a): a is Extract<DriverActivity, { type: "text" }> => a.type === "text")
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
		assert.equal(driver.state, "running", "turn should be running before the recycle");
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
		assert.equal(stats.recycles, 0, "raw knob flip stays invisible in plan mode (effective unchanged)");
		await driver.close("shutdown");
	});
});
