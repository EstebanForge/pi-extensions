import { describe, expect, it, vi } from "vitest";
import {
	buildGoldfishArgv,
	buildGoldfishTask,
	isEgmInvocation,
	isSpawnShaped,
	killAll,
	ROLE_TO_PERSONA,
	runGoldfish,
	verifyReport,
	type GoldfishParams,
	type RunOutcome,
	type Runner,
} from "../extensions/goldfish.js";

const ROOT = "/pkg/root";

describe("ROLE_TO_PERSONA", () => {
	it("maps all nine upstream personas", () => {
		expect(Object.keys(ROLE_TO_PERSONA).sort()).toEqual(
			[
				"egm-bootstrap-orchestrator",
				"egm-codebase-details",
				"egm-comprehension",
				"egm-design",
				"egm-implementation-readiness",
				"egm-structural",
				"egm-style",
				"egm-synthesizer",
				"egm-zoom-out",
			].sort(),
		);
	});

	it("resolves each role to a persona file under agents/", () => {
		for (const file of Object.values(ROLE_TO_PERSONA)) {
			expect(file).toMatch(/^agents\/[a-z_]+\.md$/);
		}
	});
});

describe("buildGoldfishArgv", () => {
	it("carries every isolation flag and passes the task via -p", () => {
		const argv = buildGoldfishArgv("do the review");
		expect(argv).toEqual([
			"--no-extensions",
			"--no-context-files",
			"--no-session",
			"--no-mcp",
			"-p",
			"do the review",
		]);
	});
});

describe("buildGoldfishTask", () => {
	const base: GoldfishParams = {
		role: "egm-zoom-out",
		target: "/repo/docs/designs/webhooks.md",
		report_path: "/repo/zoom_out_report.md",
	};

	it("puts the persona file first and adopts it as governing instructions", () => {
		const task = buildGoldfishTask(base, ROOT);
		expect(task).toContain("read the file /pkg/root/agents/zoom_out.md");
		expect(task.indexOf("agents/zoom_out.md")).toBeLessThan(task.indexOf("Target document"));
	});

	it("lists standards, goldfish context, and focus when present", () => {
		const task = buildGoldfishTask(
			{
				...base,
				standards: ["/pkg/root/resources/document_standards/zoom-out-standard.md"],
				goldfishContext: ["/repo/AGENTS.md", "/repo/docs/architecture.md"],
				focus: "caching decisions only",
			},
			ROOT,
		);
		expect(task).toContain("zoom-out-standard.md");
		expect(task).toContain("/repo/AGENTS.md");
		expect(task).toContain("/repo/docs/architecture.md");
		expect(task).toContain("caching decisions only");
	});

	it("requires artifact-first delivery to the report path", () => {
		const task = buildGoldfishTask(base, ROOT);
		expect(task).toContain("/repo/zoom_out_report.md");
		expect(task).toContain("before replying");
	});
});

describe("verifyReport", () => {
	it("fails closed on missing or empty reports", async () => {
		await expect(verifyReport("/nonexistent/report.md")).rejects.toThrow(/no report/i);
		await expect(verifyReport("/dev/null")).rejects.toThrow(/no report/i);
	});

	it("passes on a non-empty report", async () => {
		const os = await import("node:os");
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const file = path.join(os.tmpdir(), `egm-report-${Date.now()}-${process.pid}.md`);
		await fs.writeFile(file, "# Zoom Out Review\n\nFindings follow.");
		await expect(verifyReport(file)).resolves.toBe(file);
		await fs.unlink(file);
	});
});

function fakeRunner(delayMs: number, outcome?: Partial<RunOutcome>): {
	runner: Runner;
	stats: () => { maxInFlight: number; calls: number };
} {
	let inFlight = 0;
	let maxInFlight = 0;
	let calls = 0;
	const runner: Runner = vi.fn(async () => {
		calls += 1;
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((r) => setTimeout(r, delayMs));
		inFlight -= 1;
		return {
			exitCode: 0,
			aborted: false,
			timedOut: false,
			stderr: "",
			stdoutRaw: "done",
			...outcome,
		};
	});
	return { runner, stats: () => ({ maxInFlight, calls }) };
}

const spawnParams = (overrides: Partial<GoldfishParams> = {}): GoldfishParams => ({
	role: "egm-design",
	target: "/repo/design.md",
	report_path: "/repo/critic_report.md",
	...overrides,
});

describe("runGoldfish", () => {
	it("rejects unknown roles before spawning anything", async () => {
		const { runner, stats } = fakeRunner(1);
		await expect(
			runGoldfish(spawnParams({ role: "egm-nonsense" as GoldfishParams["role"] }), {
				runner,
				root: ROOT,
			}),
		).rejects.toThrow(/unknown role/i);
		expect(stats().calls).toBe(0);
	});

	it("hard-fails on timeout instead of returning a partial review", async () => {
		const { runner } = fakeRunner(1, { timedOut: true, exitCode: 124, stdoutRaw: "" });
		await expect(runGoldfish(spawnParams(), { runner, root: ROOT })).rejects.toThrow(/timed out/i);
	});

	it("hard-fails on nonzero exit and surfaces stderr", async () => {
		const { runner } = fakeRunner(1, { exitCode: 1, stderr: "boom" });
		await expect(runGoldfish(spawnParams(), { runner, root: ROOT })).rejects.toThrow(/boom/);
	});

	it("caps concurrent child sessions at three", async () => {
		const os = await import("node:os");
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const report = path.join(os.tmpdir(), `egm-cap-${Date.now()}-${process.pid}.md`);
		await fs.writeFile(report, "# Zoom Out Review\n");
		const { runner, stats } = fakeRunner(15);
		await Promise.all(
			Array.from({ length: 7 }, () => runGoldfish(spawnParams({ report_path: report }), { runner, root: ROOT })),
		);
		expect(stats().calls).toBe(7);
		expect(stats().maxInFlight).toBeLessThanOrEqual(3);
		await fs.unlink(report);
	});

	it("passes the caller's abort signal through to the runner", async () => {
		const runner = vi.fn(async (_task: string, opts: { signal?: AbortSignal }) => {
			opts.signal?.throwIfAborted();
			return { exitCode: 0, aborted: false, timedOut: false, stderr: "", stdoutRaw: "" };
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			runGoldfish(spawnParams(), { runner, root: ROOT, signal: controller.signal }),
		).rejects.toThrow();
		expect(runner).toHaveBeenCalledTimes(1);
	});
});

describe("killAll", () => {
	it("swallows individual kill failures so shutdown never throws", () => {
		const booms = (): void => {
			throw new Error("stale extension api");
		};
		expect(() => killAll([booms, () => {}])).not.toThrow();
	});
});

describe("isSpawnShaped", () => {
	it("matches session-spawning tools and not task-list tools", () => {
		expect(isSpawnShaped("agent_spawn")).toBe(true);
		expect(isSpawnShaped("spawn_agent")).toBe(true);
		expect(isSpawnShaped("subagent_run")).toBe(true);
		expect(isSpawnShaped("delegate_task")).toBe(true);
		expect(isSpawnShaped("asana_get_tasks")).toBe(false);
		expect(isSpawnShaped("todo")).toBe(false);
		expect(isSpawnShaped("read")).toBe(false);
	});
});

describe("isEgmInvocation", () => {
	it("recognizes EGM commands and skill invocations only", () => {
		expect(isEgmInvocation("/egm-review docs/design.md")).toBe(true);
		expect(isEgmInvocation("/egm-drift-report")).toBe(true);
		expect(isEgmInvocation("/skill:egm-brainstorm")).toBe(true);
		expect(isEgmInvocation("/egx")).toBe(false);
		expect(isEgmInvocation("hello")).toBe(false);
		expect(isEgmInvocation("review the /egm-review docs")).toBe(false);
	});
});
