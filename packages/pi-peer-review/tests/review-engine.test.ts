// Review engine against real fs/git fixtures with a stubbed consult: delta
// flow, pointer rules, severity contract, budget-honest refusal paths.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsultError, type ConsultOptions, type ConsultResult } from "@estebanforge/pi-ask-shared";
import { DEFAULT_SETTINGS, type UnblockSettings } from "../src/settings.js";
import { ReviewEngine, type ReviewEnginePorts } from "../src/review-engine.js";

let cwd: string;
let consultCalls: ConsultOptions[];
let answers: string[];
let failures: string[] | null;
let nextTurn: string[];
let notices: string[];
let gateOpen = true;

const settings: UnblockSettings = {
	...DEFAULT_SETTINGS,
	timeoutSec: 5,
};

function basePorts(): ReviewEnginePorts {
	return {
		runConsult: async (opts) => {
			consultCalls.push(opts);
			if (failures && failures.length) throw new ConsultError(failures.shift() as never, { stderr: "boom" });
			const answer = answers.shift() ?? "NO_BLOCKERS";
			return { answer, sessionId: null, exitCode: 0, timedOut: false, aborted: false } as ConsultResult;
		},
		nowMs: () => Date.now(),
		notify: (t) => notices.push(t),
		injectNextTurn: (t) => nextTurn.push(t),
		tryStart: () => ({ started: gateOpen, blockedBy: gateOpen ? undefined : "in-flight" }),
		end: () => {},
	};
}

const engine = () => new ReviewEngine({ cwd, getSettings: () => settings, ports: basePorts() });

function git(args: string[]): void {
	execFileSync("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
		encoding: "utf-8",
	});
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "unblock-eng-"));
	consultCalls = [];
	answers = ["NO_BLOCKERS"];
	failures = null;
	nextTurn = [];
	notices = [];
	gateOpen = true;
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

const setupGitRepo = (): void => {
	execFileSync("git", ["init", "-q"], { cwd });
	writeFileSync(join(cwd, "a.ts"), "one\n");
	git(["add", "-A"]);
	git(["commit", "-qm", "base"]);
};

const changeWork = (): void => {
	writeFileSync(join(cwd, "a.ts"), "one two\n");
	writeFileSync(join(cwd, "b.ts"), "brand new\n");
};

describe("ReviewEngine", () => {
	it("reviews the git delta, carries the contract, and advances the pointer", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		changeWork();
		await e.peerReview({});

		expect(consultCalls).toHaveLength(1);
		const prompt = consultCalls[0]!.prompt;
		expect(prompt).toContain("+one two");
		expect(prompt).toContain("BLOCKER");
		expect(prompt).toContain("NO_BLOCKERS");
		expect(consultCalls[0]!.peer).toBe("claude");

		// Nothing changed since the review: no second consult, told instead.
		await e.peerReview({});
		expect(consultCalls).toHaveLength(1);
		expect(notices.some((n) => n.toLowerCase().includes("nothing changed"))).toBe(true);
	});

	it("keeps the pointer on a failed review so the wave stays covered", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		changeWork();
		failures = ["timeout"];
		await e.peerReview({});
		expect(notices.some((n) => n.includes("timeout"))).toBe(true);

		answers = ["NO_BLOCKERS"];
		await e.peerReview({});
		expect(consultCalls).toHaveLength(2);
	});

	it("override picks the reviewer and its per-reviewer model/effort", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		changeWork();
		settings.codexModel = "gpt-6.1";
		settings.codexEffort = "xhigh";
		await e.peerReview({ reviewer: "codex" });

		expect(consultCalls[0]!.peer).toBe("codex");
		expect(consultCalls[0]!.model).toBe("gpt-6.1");
		expect(consultCalls[0]!.codex?.reasoning).toBe("xhigh");
		settings.codexModel = null;
		settings.codexEffort = null;
	});

	it("global model/effort flow into the claude consult", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		changeWork();
		settings.model = "opus";
		settings.effort = "high";
		await e.peerReview({});
		expect(consultCalls[0]!.model).toBe("opus");
		expect(consultCalls[0]!.claude?.effort).toBe("high");
		settings.model = null;
		settings.effort = null;
	});

	it("sends BLOCKER and RISK findings to the executor, never NITs", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		changeWork();
		answers = ["BLOCKER: auth bypass in a.ts:1\nRISK: loop can spin\nNIT: rename x"];
		await e.peerReview({});

		expect(nextTurn).toHaveLength(1);
		const injected = nextTurn[0]!;
		expect(injected).toContain("auth bypass");
		expect(injected).toContain("loop can spin");
		expect(injected).not.toContain("rename x");
		expect(injected.toLowerCase()).toContain("untrusted");
	});

	it("never auto-sends an answer that ignores the severity contract", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		changeWork();
		answers = ["Looks fine to me, ship it."];
		await e.peerReview({});
		expect(nextTurn).toHaveLength(0);
		expect(notices.some((n) => n.includes("no severity markers"))).toBe(true);
	});

	it("runs an audit (no diff) outside a git repo and says so", async () => {
		writeFileSync(join(cwd, "only.ts"), "export const x = 1;\n");
		const e = engine();
		await e.baseline();
		writeFileSync(join(cwd, "only.ts"), "export const x = 2;\n");
		await e.peerReview({});

		expect(consultCalls).toHaveLength(1);
		const prompt = consultCalls[0]!.prompt;
		expect(prompt).toContain("audit");
		expect(prompt).toContain("export const x = 2;");
	});

	it("withholds secret-path content but names the file", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		writeFileSync(join(cwd, ".env.local"), "SECRET_TOKEN=abc123\n");
		await e.peerReview({});
		const prompt = consultCalls[0]!.prompt;
		expect(prompt).not.toContain("SECRET_TOKEN=abc123");
		expect(prompt).toContain(".env.local");
	});

	it("reports the unreviewed count for the publish gate and clears it", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		changeWork();
		expect(await e.unreviewedLine()).toContain("2 files changed");

		await e.peerReview({});
		expect(await e.unreviewedLine()).toBeNull();
	});

	it("carries previous findings into a verification pass", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		changeWork();
		answers = ["BLOCKER: sql injection in a.ts:12"];
		await e.peerReview({});

		writeFileSync(join(cwd, "a.ts"), "one two three\n");
		answers = ["NO_BLOCKERS"];
		await e.peerReview({});
		const prompt = consultCalls[1]!.prompt;
		expect(prompt).toContain("VERIFICATION PASS");
		expect(prompt).toContain("sql injection in a.ts:12");
	});

	it("re-baselines when the backend flips mid-session", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		rmSync(join(cwd, ".git"), { recursive: true, force: true });
		writeFileSync(join(cwd, "plain.txt"), "no git here\n");
		await e.peerReview({});
		const prompt = consultCalls[0]!.prompt;
		expect(prompt).toContain("audit");
	});

	it("stays silent (no consult) when a gate blocks the review", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		changeWork();
		gateOpen = false;
		await e.peerReview({});
		expect(consultCalls).toHaveLength(0);
		expect(notices.some((n) => n.includes("in-flight"))).toBe(true);
	});

	it("keeps files created during the consult under review (files backend)", async () => {
		const e = engine();
		await e.baseline();
		writeFileSync(join(cwd, "early.ts"), "early\n");
		// The consult runs while the executor (or human) keeps working: the
		// stub writes a new file mid-consult, with an mtime before the consult
		// ended. The pointer inherits the delta time, so the next review must
		// still see it.
		const base = basePorts();
		const enginePorts: ReviewEnginePorts = {
			...base,
			runConsult: async (opts) => {
				consultCalls.push(opts);
				writeFileSync(join(cwd, "late.ts"), "written mid-consult\n");
				return { answer: "NO_BLOCKERS", sessionId: null, exitCode: 0, timedOut: false, aborted: false } as ConsultResult;
			},
		};
		const busy = new ReviewEngine({ cwd, getSettings: () => settings, ports: enginePorts });
		await busy.baseline();
		writeFileSync(join(cwd, "wave.ts"), "wave\n");
		await busy.peerReview({});
		expect(consultCalls).toHaveLength(1);

		await busy.peerReview({});
		expect(consultCalls).toHaveLength(2);
		expect(consultCalls[1]!.prompt).toContain("written mid-consult");
	});

	it("hands the publish gate a frame and marks the wave reviewed", async () => {
		setupGitRepo();
		const e = engine();
		await e.baseline();
		changeWork();
		const frame = await e.publishFrame();
		expect(frame).toContain("publish");
		expect(frame).toContain("+one two");

		e.markReviewed();
		expect(await e.unreviewedLine()).toBeNull();
	});
});
