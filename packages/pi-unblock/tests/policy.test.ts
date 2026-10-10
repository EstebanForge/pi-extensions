// Pure policy characterization for pi-unblock. Zero I/O: state machines,
// predicates, and gates only. The extension entrypoint applies these to real
// tool-call events; the consult core is consumed behind noteConsultStarted.
import { describe, expect, it } from "vitest";
import {
	commandRoot,
	isPublishCommand,
	newUnblockState,
	noteConsultSettled,
	noteConsultStarted,
	noteToolResult,
	resetStreak,
	type ToolObservation,
} from "../src/policy.js";

const GATES = { threshold: 3, cooldownSec: 120, maxAutoConsults: 3, nowMs: 1_000_000 };

const obs = (tool: string, ok: boolean, turn: number, command?: string): ToolObservation => ({
	tool,
	ok,
	turn,
	command,
});

describe("commandRoot", () => {
	it("takes the first token and strips paths", () => {
		expect(commandRoot("/usr/bin/git push origin main")).toBe("git");
		expect(commandRoot("npm test")).toBe("npm");
	});

	it("skips environment assignments", () => {
		expect(commandRoot("FOO=1 BAR=2 git push")).toBe("git");
	});

	it("returns null for empty or assignment-only commands", () => {
		expect(commandRoot("")).toBeNull();
		expect(commandRoot("   ")).toBeNull();
		expect(commandRoot("FOO=1")).toBeNull();
	});
});

describe("failure streak", () => {
	it("triggers exactly at the threshold on one key", () => {
		const st = newUnblockState();
		expect(noteToolResult(st, obs("exec", false, 1, "npm test"), GATES).trigger).toBe(false);
		expect(noteToolResult(st, obs("exec", false, 1, "npm test"), GATES).trigger).toBe(false);
		const third = noteToolResult(st, obs("exec", false, 1, "npm test"), GATES);
		expect(third.trigger).toBe(true);
		expect(third.key).toBe("exec:npm");
		// Fourth failure: past the threshold, one shot per streak.
		expect(noteToolResult(st, obs("exec", false, 1, "npm test"), GATES).trigger).toBe(false);
	});

	it("does not stack unrelated command roots", () => {
		const st = newUnblockState();
		noteToolResult(st, obs("exec", false, 1, "npm test"), GATES);
		noteToolResult(st, obs("exec", false, 1, "npm test"), GATES);
		const d = noteToolResult(st, obs("exec", false, 1, "cargo build"), GATES);
		expect(d.trigger).toBe(false);
	});

	it("stacks non-exec tools by tool name", () => {
		const st = newUnblockState();
		expect(noteToolResult(st, obs("edit", false, 1), GATES).trigger).toBe(false);
		expect(noteToolResult(st, obs("edit", false, 1), GATES).trigger).toBe(false);
		expect(noteToolResult(st, obs("edit", false, 1), GATES).trigger).toBe(true);
	});

	it("a success on the same key resets the streak; other keys do not", () => {
		const st = newUnblockState();
		noteToolResult(st, obs("exec", false, 1, "npm test"), GATES);
		noteToolResult(st, obs("exec", false, 1, "npm test"), GATES);
		noteToolResult(st, obs("exec", true, 1, "npm test"), GATES);
		expect(noteToolResult(st, obs("exec", false, 1, "npm test"), GATES).trigger).toBe(false);
		// An unrelated read success between failures must not mask the loop.
		noteToolResult(st, obs("exec", false, 1, "npm test"), GATES);
		noteToolResult(st, obs("read", true, 1), GATES);
		expect(noteToolResult(st, obs("exec", false, 1, "npm test"), GATES).trigger).toBe(true);
	});

	it("ignores exploratory commands entirely", () => {
		const st = newUnblockState();
		for (let i = 0; i < 5; i++) {
			const d = noteToolResult(st, obs("exec", false, 1, "rg missing"), GATES);
			expect(d.trigger).toBe(false);
		}
		// grep/rg exit 1 on no-match is not a failure signal (agy amendment 3).
		expect(noteToolResult(st, obs("exec", false, 1, "grep -r foo ."), GATES).trigger).toBe(false);
	});

	it("decays the streak after a turn boundary with no repeat", () => {
		const st = newUnblockState();
		noteToolResult(st, obs("exec", false, 1, "npm test"), GATES);
		noteToolResult(st, obs("exec", false, 2, "npm test"), GATES);
		// Turn 4 skips turn 3: one-turn decay resets the count.
		expect(noteToolResult(st, obs("exec", false, 4, "npm test"), GATES).trigger).toBe(false);
	});
});

describe("consult gates", () => {
	it("blocks while a consult is in flight", () => {
		const st = newUnblockState();
		expect(noteConsultStarted(st, 1_000_000).started).toBe(true);
		expect(noteConsultStarted(st, 1_000_001)).toEqual({ started: false, blockedBy: "in-flight" });
		noteConsultSettled(st);
	});

	it("blocks after the session budget is spent", () => {
		const st = newUnblockState();
		// cooldownSec 0 isolates the budget gate.
		expect(noteConsultStarted(st, 1_000_000, { cooldownSec: 0 }).started).toBe(true);
		noteConsultSettled(st);
		expect(noteConsultStarted(st, 1_100_000, { cooldownSec: 0 }).started).toBe(true);
		noteConsultSettled(st);
		expect(noteConsultStarted(st, 1_200_000, { cooldownSec: 0 }).started).toBe(true);
		noteConsultSettled(st);
		// maxAutoConsults 3: the fourth is manual-only territory.
		expect(
			noteConsultStarted(st, 1_300_000, { maxAutoConsults: 3, cooldownSec: 0 }),
		).toEqual({ started: false, blockedBy: "budget" });
	});

	it("blocks within the cooldown and allows after it", () => {
		const st = newUnblockState();
		expect(noteConsultStarted(st, 1_000_000, { cooldownSec: 120 }).started).toBe(true);
		noteConsultSettled(st);
		// 60s later: inside the 120s cooldown.
		expect(noteConsultStarted(st, 1_060_000, { cooldownSec: 120 })).toEqual({ started: false, blockedBy: "cooldown" });
		// 121s later: clear.
		expect(noteConsultStarted(st, 1_121_000, { cooldownSec: 120 }).started).toBe(true);
	});

	it("settling clears the in-flight flag and the streak", () => {
		const st = newUnblockState();
		noteConsultStarted(st, 1_000_000);
		noteToolResult(st, obs("exec", false, 1, "npm test"), GATES);
		noteConsultSettled(st);
		// The failed consult consumed its streak: the counter is back to zero.
		expect(noteToolResult(st, obs("exec", false, 1, "npm test"), GATES).trigger).toBe(false);
	});
});

describe("key-scoped settle and resetStreak", () => {
	it("a settle with a key preserves a non-matching streak", () => {
		const st = newUnblockState();
		noteToolResult(st, obs("exec", false, 1, "npm test"), GATES);
		const first = noteToolResult(st, obs("exec", false, 1, "npm test"), GATES);
		expect(first.trigger).toBe(false);
		// A publish consult settles with its own key: the failure loop's
		// count must survive.
		noteConsultSettled(st, "publish:git");
		expect(noteToolResult(st, obs("exec", false, 1, "npm test"), GATES).trigger).toBe(true);
	});

	it("resetStreak drops the streak without touching the in-flight flag", () => {
		const st = newUnblockState();
		expect(noteConsultStarted(st, 1_000_000).started).toBe(true);
		noteToolResult(st, obs("exec", false, 1, "npm test"), GATES);
		resetStreak(st);
		expect(st.consultInFlight).toBe(true);
		expect(noteToolResult(st, obs("exec", false, 1, "npm test"), GATES).trigger).toBe(false);
	});
});

describe("isPublishCommand", () => {
	it("matches git push and gh pr create in any segment", () => {
		expect(isPublishCommand("git push")).toBe(true);
		expect(isPublishCommand("git push origin main")).toBe(true);
		expect(isPublishCommand("FOO=1 git push --force-with-lease")).toBe(true);
		expect(isPublishCommand("git commit -m x && git push")).toBe(true);
		expect(isPublishCommand("npm test; gh pr create --draft")).toBe(true);
	});

	it("rejects lookalikes and non-publish commands", () => {
		expect(isPublishCommand("git status")).toBe(false);
		expect(isPublishCommand("git pushd")).toBe(false);
		expect(isPublishCommand("echo git push")).toBe(false);
		expect(isPublishCommand("npm publish")).toBe(false);
		expect(isPublishCommand("gh pr view 12")).toBe(false);
		expect(isPublishCommand("")).toBe(false);
	});
});
