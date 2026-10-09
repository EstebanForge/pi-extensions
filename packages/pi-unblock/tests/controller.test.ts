// Controller characterization with a stub peer CLI driving the REAL consult
// core (process spawn, event parsing, sanitization) end to end — this is the
// #9 E2E scenario: failure loop -> consult -> visible injection.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runConsult, type ConsultOptions } from "@estebanforge/pi-ask-shared";
import { UnblockController, type ControllerPorts } from "../src/controller.js";
import { DEFAULT_SETTINGS, type UnblockSettings } from "../src/settings.js";

const execFileAsync = promisify(execFile);
const FIXTURE = join(import.meta.dirname, "../../pi-ask-shared/tests/fixtures/peer-fake.mjs");
const binary = process.execPath;

function makePorts(overrides: Partial<ControllerPorts> = {}): {
	ports: ControllerPorts;
	notifications: string[];
	injections: string[];
} {
	const notifications: string[] = [];
	const injections: string[] = [];
	return {
		notifications,
		injections,
		ports: {
			notify: (t) => notifications.push(t),
			inject: (t) => injections.push(t),
			runConsult,
			nowMs: () => 1_000_000,
			...overrides,
		},
	};
}

const settingsWith = (over: Partial<UnblockSettings> = {}): UnblockSettings => ({
	...DEFAULT_SETTINGS,
	binary,
	threshold: 3,
	cooldownSec: 0,
	timeoutSec: 10,
	reviewer: "claude",
	...over,
});

// The stub claude-consult fixture requires a non-empty stdin prompt and
// replies with the pinned REVIEW VERDICT answer.
async function stubConsult(ports: ControllerPorts): Promise<ControllerPorts> {
	await execFileAsync(process.execPath, [FIXTURE, "exit-code", "0"]);
	return {
		...ports,
		runConsult: (opts: ConsultOptions) =>
			runConsult({ ...opts, binary: process.execPath, args: [FIXTURE, "claude-consult"] }),
	};
}

async function loopUntilTrigger(c: UnblockController, turns = 1): Promise<void> {
	for (let t = 0; t < turns; t++) {
		c.onTurnStart();
		// The model retries the failing command within the turn: three strikes
		// before the turn ends.
		for (let i = 0; i < 3; i++) {
			c.onToolResult("bash", false, "npm test", "FAIL src/x.test.ts\n3 failed");
		}
	}
	// Allow the detached consult to settle.
	await new Promise((r) => setTimeout(r, 250));
}

describe("UnblockController: failure loop -> consult -> injection (E2E)", () => {
	it("consults the stub reviewer and injects the sanitized notice", async () => {
		const base = makePorts();
		const ports = await stubConsult(base.ports);
		const c = new UnblockController(settingsWith(), ports);
		await loopUntilTrigger(c);
		expect(base.injections).toHaveLength(1);
		expect(base.injections[0]).toContain("[SYSTEM NOTICE");
		expect(base.injections[0]).toContain("REVIEW VERDICT: ship it");
		// ANSI stripped by the consult core.
		expect(base.injections[0]).not.toContain("\x1b[");
	});

	it("does not inject when autoUnblockOnFailure is off (notify only)", async () => {
		const { ports, injections, notifications } = makePorts();
		const c = new UnblockController(settingsWith({ autoUnblockOnFailure: false }), ports);
		await loopUntilTrigger(c);
		expect(injections).toHaveLength(0);
		expect(notifications.some((n) => n.includes("auto-consult disabled"))).toBe(true);
	});

	it("streak resets after a same-key success and blocks the trigger", async () => {
		const { ports, injections } = makePorts();
		const c = new UnblockController(settingsWith(), ports);
		c.onTurnStart();
		c.onToolResult("bash", false, "npm test", "fail");
		c.onToolResult("bash", false, "npm test", "fail");
		c.onToolResult("bash", true, "npm test", "all pass");
		c.onToolResult("bash", false, "npm test", "fail");
		await new Promise((r) => setTimeout(r, 100));
		expect(injections).toHaveLength(0);
	});

	it("a failed consult consumes the streak and notifies only", async () => {
		const { ports, injections, notifications } = makePorts({
			runConsult: () => Promise.reject(Object.assign(new Error("consult failed: timeout"), {})),
		});
		const c = new UnblockController(settingsWith(), ports);
		await loopUntilTrigger(c);
		expect(injections).toHaveLength(0);
		expect(notifications.some((n) => n.includes("consult failed"))).toBe(true);
		// The settled streak restarts from zero, not from 3.
		notifications.length = 0;
		await loopUntilTrigger(c);
		expect(notifications.some((n) => n.includes("consult failed"))).toBe(true);
	});
});

describe("UnblockController: publish boundary", () => {
	it("blocks without running when the user declines", async () => {
		const { ports, injections } = makePorts({
			confirm: () => Promise.resolve(false),
		});
		const c = new UnblockController(settingsWith(), ports);
		const verdict = await c.onBeforePublish("git push origin main");
		expect(verdict).toEqual({ block: true, reason: "publish declined at the unblock gate" });
		expect(injections).toHaveLength(0);
	});

	it("on approval consults synchronously, injects, and lets the command run", async () => {
		const base = makePorts({ confirm: () => Promise.resolve(true) });
		const c = new UnblockController(settingsWith(), await stubConsult(base.ports));
		const verdict = await c.onBeforePublish("git commit -m x && git push");
		expect(verdict).toBeUndefined();
		expect(base.injections).toHaveLength(1);
		expect(base.injections[0]).toContain("REVIEW VERDICT");
	});

	it("ignores non-publish commands entirely", async () => {
		const { ports, injections } = makePorts({
			confirm: () => Promise.resolve(false),
		});
		const c = new UnblockController(settingsWith(), ports);
		expect(await c.onBeforePublish("git status")).toBeUndefined();
		expect(await c.onBeforePublish("echo git push")).toBeUndefined();
		expect(injections).toHaveLength(0);
	});

	it("degrades to skip-and-log when no confirm UI exists", async () => {
		const { ports, notifications } = makePorts({});
		const c = new UnblockController(settingsWith(), ports);
		const verdict = await c.onBeforePublish("git push");
		expect(verdict).toBeUndefined();
		expect(notifications.some((n) => n.includes("no confirm UI"))).toBe(true);
	});

	it("confirmOnPush=false disables the gate completely", async () => {
		const { ports, notifications } = makePorts({
			confirm: () => Promise.resolve(false),
		});
		const c = new UnblockController(settingsWith({ confirmOnPush: false }), ports);
		expect(await c.onBeforePublish("git push")).toBeUndefined();
		expect(notifications).toHaveLength(0);
	});
});

describe("UnblockController: manual consult", () => {
	it("/unblock injects the reviewer answer without spending the auto budget", async () => {
		const { ports, injections } = makePorts();
		const c = new UnblockController(settingsWith(), await stubConsult(ports));
		await c.manualConsult("why do the tests fail");
		expect(injections).toHaveLength(1);
		expect(injections[0]).toContain("REVIEW VERDICT");
	});
});
