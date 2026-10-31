import { describe, expect, it, vi } from "vitest";
import {
	buildGoldfishArgv,
	buildGoldfishTask,
	buildModelArgs,
	disarmGuard,
	isGuardArmed,
	isSpawnShaped,
	killAll,
	MAX_CONCURRENT_GOLDFISH,
	Params,
	registerGoldfish,
	ROLE_TO_PERSONA,
	runGoldfish,
	THINKING_LEVELS,
	verifyReport,
	type GoldfishParams,
	type RunOutcome,
	type Runner,
} from "../extensions/goldfish.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	it("carries every isolation and discovery-suppression flag, the review tool policy, and passes the task via -p", () => {
		const argv = buildGoldfishArgv("do the review");
		expect(argv).toEqual([
			"--no-extensions",
			"--no-context-files",
			"--no-session",
			"--no-mcp",
			"--no-skills",
			"--no-prompt-templates",
			"--exclude-tools",
			"edit",
			"-p",
			"do the review",
		]);
	});

	it("appends the model pattern before the task when a model is requested", () => {
		const argv = buildGoldfishArgv("do the review", ["--model", "zai/glm-5.3-flash"]);
		expect(argv.slice(0, -2)).toContain("--model");
		expect(argv.at(-1)).toBe("do the review");
		expect(argv.at(-2)).toBe("-p");
	});
});

describe("buildModelArgs", () => {
	it("emits nothing without a model or level", () => {
		expect(buildModelArgs()).toEqual([]);
	});

	it("emits --model alone for a model without a level", () => {
		expect(buildModelArgs("zai/glm-5.3-flash")).toEqual(["--model", "zai/glm-5.3-flash"]);
	});

	it("emits independent --model and --thinking flags", () => {
		expect(buildModelArgs("zai/glm-5.3-flash", "high")).toEqual([
			"--model",
			"zai/glm-5.3-flash",
			"--thinking",
			"high",
		]);
	});

	it("emits --thinking alone, pi accepts it without a model", () => {
		expect(buildModelArgs(undefined, "low")).toEqual(["--thinking", "low"]);
	});
});

describe("goldfish tool schema parity", () => {
	it("schema properties match the GoldfishParams keys", () => {
		expect(Object.keys(Params.properties).sort()).toEqual(
			[
				"role",
				"target",
				"report_path",
				"standards",
				"goldfishContext",
				"focus",
				"timeout_minutes",
				"model",
				"thinking_level",
			].sort(),
		);
	});

	it("role union covers exactly the persona roles", () => {
		const literals = Params.properties.role.anyOf.map((s: { const: string }) => s.const);
		expect(literals.sort()).toEqual(Object.keys(ROLE_TO_PERSONA).sort());
	});

	it("thinking_level union matches the pi thinking ladder", () => {
		const literals = Params.properties.thinking_level.anyOf.map((s: { const: string }) => s.const);
		expect(literals).toEqual([...THINKING_LEVELS]);
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
			signal: null,
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

	it("accepts a thinking level without a model, passing --thinking alone", async () => {
		const seen: Array<string[] | undefined> = [];
		const os = await import("node:os");
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const report = path.join(os.tmpdir(), `egm-think-${Date.now()}-${process.pid}.md`);
		await fs.writeFile(report, "# Zoom Out Review\n");
		const runner: Runner = async (_task, opts) => {
			seen.push(opts.modelArgs);
			return { exitCode: 0, signal: null, aborted: false, timedOut: false, stderr: "", stdoutRaw: "done" };
		};
		await runGoldfish(spawnParams({ thinking_level: "high", report_path: report }), {
			runner,
			root: ROOT,
		});
		expect(seen).toEqual([["--thinking", "high"]]);
		await fs.unlink(report);
	});

	it("rejects a non-positive timeout before spawning", async () => {
		const { runner, stats } = fakeRunner(1);
		await expect(
			runGoldfish(spawnParams({ timeout_minutes: 0 }), { runner, root: ROOT }),
		).rejects.toThrow(/timeout/i);
		expect(stats().calls).toBe(0);
	});

	it("rejects an already-aborted signal before acquiring a slot", async () => {
		const { runner, stats } = fakeRunner(1);
		const controller = new AbortController();
		controller.abort();
		await expect(
			runGoldfish(spawnParams(), { runner, root: ROOT, signal: controller.signal }),
		).rejects.toThrow(/aborted/i);
		expect(stats().calls).toBe(0);
	});

	it("releases slots after failing runs so later reviews still proceed", async () => {
		const os = await import("node:os");
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const report = path.join(os.tmpdir(), `egm-release-${Date.now()}-${process.pid}.md`);
		await fs.writeFile(report, "# Zoom Out Review\n");
		const { runner, stats } = fakeRunner(1, { exitCode: 1, stderr: "boom" });
		for (let i = 0; i < MAX_CONCURRENT_GOLDFISH; i++) {
			await expect(
				runGoldfish(spawnParams({ report_path: report }), { runner, root: ROOT }),
			).rejects.toThrow();
		}
		const fresh = fakeRunner(1);
		await expect(
			runGoldfish(spawnParams({ report_path: report }), { runner: fresh.runner, root: ROOT }),
		).resolves.toMatchObject({ report_path: report });
		expect(stats().calls).toBe(MAX_CONCURRENT_GOLDFISH);
		expect(fresh.stats().calls).toBe(1);
		await fs.unlink(report);
	});

	it("passes the caller's abort signal through to the runner", async () => {
		const runner = vi.fn(async (_task: string, opts: { signal?: AbortSignal }) => {
			await new Promise((r) => setTimeout(r, 50));
			opts.signal?.throwIfAborted();
			return { exitCode: 0, signal: null, aborted: false, timedOut: false, stderr: "", stdoutRaw: "" };
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		await expect(
			runGoldfish(spawnParams(), { runner, root: ROOT, signal: controller.signal }),
		).rejects.toThrow();
		expect(runner).toHaveBeenCalledTimes(1);
	});

	it("hands model arguments to the runner so children run on the requested model", async () => {
		const seen: Array<string[] | undefined> = [];
		const os = await import("node:os");
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const report = path.join(os.tmpdir(), `egm-model-${Date.now()}-${process.pid}.md`);
		await fs.writeFile(report, "# Critic Review\n");
		const runner: Runner = async (_task, opts) => {
			seen.push(opts.modelArgs);
			return { exitCode: 0, signal: null, aborted: false, timedOut: false, stderr: "", stdoutRaw: "done" };
		};
		await runGoldfish(spawnParams({ model: "flash", thinking_level: "high", report_path: report }), {
			runner,
			root: ROOT,
		});
		expect(seen).toEqual([["--model", "flash", "--thinking", "high"]]);
		await fs.unlink(report);
	});

	it("omits model arguments when no model is requested", async () => {
		const seen: Array<string[] | undefined> = [];
		const os = await import("node:os");
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const report = path.join(os.tmpdir(), `egm-nomodel-${Date.now()}-${process.pid}.md`);
		await fs.writeFile(report, "# Critic Review\n");
		const runner: Runner = async (_task, opts) => {
			seen.push(opts.modelArgs);
			return { exitCode: 0, signal: null, aborted: false, timedOut: false, stderr: "", stdoutRaw: "done" };
		};
		await runGoldfish(spawnParams({ report_path: report }), { runner, root: ROOT });
		expect(seen).toEqual([[]]);
		await fs.unlink(report);
	});
});

describe("default runner", () => {
	it("invokes pi with the isolation, discovery, policy, and model flags", async () => {
		const os = await import("node:os");
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "egm-fake-pi-"));
		const argvFile = path.join(dir, "argv.txt");
		const report = path.join(dir, "report.md");
		await fs.writeFile(report, "# Zoom Out Review\n");
		const fakePi = [
			"#!/usr/bin/env bash",
			`printf '%s\n' "$@" > ${JSON.stringify(argvFile)}`,
			"exit 0",
			"",
		].join("\n");
		await fs.writeFile(path.join(dir, "pi"), fakePi, { mode: 0o755 });
		const savedPath = process.env.PATH;
		process.env.PATH = `${dir}:${savedPath}`;
		try {
			const result = await runGoldfish(
				spawnParams({
					report_path: report,
					model: "zai/glm-5.3-flash",
					thinking_level: "high",
				}),
				{ root: ROOT },
			);
			expect(result.report_path).toBe(report);
		} finally {
			process.env.PATH = savedPath;
		}
		const argv = (await fs.readFile(argvFile, "utf8")).split("\n");
		// The task is multiline, so assert the flag block positionally: exactly
		// the 12 builder args precede -p, then the task.
		expect(argv.slice(0, 12)).toEqual([
			"--no-extensions",
			"--no-context-files",
			"--no-session",
			"--no-mcp",
			"--no-skills",
			"--no-prompt-templates",
			"--exclude-tools",
			"edit",
			"--model",
			"zai/glm-5.3-flash",
			"--thinking",
			"high",
		]);
		expect(argv[12]).toBe("-p");
		expect(argv[13]).toContain("Goldfish reviewer");
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

describe("registerGoldfish guard wiring", () => {
	type Handler = (event: unknown) => unknown;
	function stubPi() {
		const handlers: Record<string, Handler> = {};
		let registeredTool: { execute: Function } | undefined;
		const pi = {
			registerTool: (tool: { execute: Function }) => {
				registeredTool = tool;
			},
			on: (event: string, handler: Handler) => {
				handlers[event] = handler;
			},
		};
		return { pi, handlers, tool: () => registeredTool! };
	}

	it("arms on any tool call touching EGM artifacts under the package root", () => {
		const { pi, handlers } = stubPi();
		registerGoldfish(pi as unknown as ExtensionAPI, ROOT);
		handlers["tool_call"]({ toolName: "read", input: { path: `${ROOT}/skills/egm-review/SKILL.md` } });
		expect(isGuardArmed()).toBe(true);
		disarmGuard();
	});

	it("stays armed across unrelated user input for the rest of the session", () => {
		const { pi, handlers } = stubPi();
		registerGoldfish(pi as unknown as ExtensionAPI, ROOT);
		handlers["tool_call"]({ toolName: "read", input: { path: `${ROOT}/PI.md` } });
		// The old input-disarm logic killed the guard here; EGM flows are
		// multi-turn and interleaved gate answers are not flow exits.
		handlers["input"]?.({ text: "answer to an EGM gate question", source: "interactive" });
		expect(isGuardArmed()).toBe(true);
		disarmGuard();
	});

	it("blocks spawn-shaped tools while armed and exempts egm_goldfish", () => {
		const { pi, handlers } = stubPi();
		registerGoldfish(pi as unknown as ExtensionAPI, ROOT);
		handlers["tool_call"]({ toolName: "read", input: { path: `${ROOT}/agents/zoom_out.md` } });
		expect(handlers["tool_call"]({ toolName: "agent_spawn", input: {} })).toEqual({
			block: true,
			reason: expect.stringMatching(/egm_goldfish/),
		});
		expect(handlers["tool_call"]({ toolName: "egm_goldfish", input: {} })).toBeUndefined();
		disarmGuard();
	});

	it("does not arm on unrelated reads", () => {
		const { pi, handlers } = stubPi();
		registerGoldfish(pi as unknown as ExtensionAPI, ROOT);
		handlers["tool_call"]({ toolName: "read", input: { path: "/repo/AGENTS.md" } });
		expect(isGuardArmed()).toBe(false);
	});

	it("registers no input-disarm handler", () => {
		const { pi, handlers } = stubPi();
		registerGoldfish(pi as unknown as ExtensionAPI, ROOT);
		expect(handlers["input"]).toBeUndefined();
	});
});
