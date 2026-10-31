import { runProcess, MAX_TIMEOUT_MINUTES } from "@estebanforge/pi-agents-shared";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/** Role -> persona file, relative to the package root. Roles are the names
 * upstream skills dispatch under; the map is enforced here in code so a skill
 * cannot substitute a same-named file from the user's project. */
export const ROLE_TO_PERSONA = {
	"egm-bootstrap-orchestrator": "agents/bootstrap_orchestrator.md",
	"egm-codebase-details": "agents/codebase_details.md",
	"egm-comprehension": "agents/comprehension.md",
	"egm-design": "agents/design_critic.md",
	"egm-implementation-readiness": "agents/implementation_readiness.md",
	"egm-structural": "agents/structural.md",
	"egm-style": "agents/style.md",
	"egm-synthesizer": "agents/synthesizer.md",
	"egm-zoom-out": "agents/zoom_out.md",
} as const;

export type GoldfishRole = keyof typeof ROLE_TO_PERSONA;

export interface GoldfishParams {
	role: GoldfishRole;
	target: string;
	report_path: string;
	standards?: string[];
	goldfishContext?: string[];
	focus?: string;
	timeout_minutes?: number;
}

export interface RunOutcome {
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	stderr: string;
	stdoutRaw: string;
}

export type Runner = (task: string, opts: { signal?: AbortSignal }) => Promise<RunOutcome>;

export const MAX_CONCURRENT_GOLDFISH = 3;
const DEFAULT_TIMEOUT_MINUTES = 15;

const Params = Type.Object({
	role: Type.Union(
		Object.keys(ROLE_TO_PERSONA).map((r) => Type.Literal(r)),
		{ description: "Which EGM persona the fresh reviewer adopts." },
	),
	target: Type.String({ description: "Absolute path of the design document under review." }),
	report_path: Type.String({
		description: "Absolute path where the reviewer writes its full report before replying.",
	}),
	standards: Type.Optional(
		Type.Array(Type.String(), {
			description: "Absolute paths of EGM document standards the reviewer must apply.",
		}),
	),
	goldfishContext: Type.Optional(
		Type.Array(Type.String(), {
			description: "Absolute paths of baseline files to read before reviewing.",
		}),
	),
	focus: Type.Optional(
		Type.String({ description: "Optional narrowing instruction for this review." }),
	),
	timeout_minutes: Type.Optional(
		Type.Number({
			description: `Hard ceiling for the child review session. Default ${DEFAULT_TIMEOUT_MINUTES}, max ${MAX_TIMEOUT_MINUTES}.`,
		}),
	),
});

interface GoldfishDetails {
	report_path?: string;
	tail?: string;
}

export type GoldfishToolArgs = Static<typeof Params>;

export function buildGoldfishArgv(task: string): string[] {
	return ["--no-extensions", "--no-context-files", "--no-session", "--no-mcp", "-p", task];
}

export function buildGoldfishTask(params: GoldfishParams, root: string): string {
	const personaPath = `${root}/${ROLE_TO_PERSONA[params.role]}`;
	const lines = [
		"You are a fresh-context Goldfish reviewer for the Elephant-Goldfish Model.",
		"Your context holds nothing about this design except what you read now.",
		"",
		`First instruction: read the file ${personaPath} and adopt it as your governing instructions.`,
	];
	if (params.standards?.length) {
		lines.push("", "Apply these standards:");
		for (const s of params.standards) lines.push(`- ${s}`);
	}
	if (params.goldfishContext?.length) {
		lines.push("", "Read this baseline material before reviewing:");
		for (const g of params.goldfishContext) lines.push(`- ${g}`);
	}
	lines.push("", `Target document: ${params.target}`);
	if (params.focus) lines.push("", `Focus: ${params.focus}`);
	lines.push(
		"",
		`Write your complete report to ${params.report_path} before replying.`,
		"Your reply must be only a two-line summary: the verdict and the report path.",
	);
	return lines.join("\n");
}

export async function verifyReport(reportPath: string): Promise<string> {
	const { stat } = await import("node:fs/promises");
	let size = 0;
	try {
		size = (await stat(reportPath)).size;
	} catch {
		throw new Error(`reviewer wrote no report at ${reportPath}`);
	}
	if (size === 0) throw new Error(`reviewer wrote no report at ${reportPath} (empty file)`);
	return reportPath;
}

/** Run one Goldfish review in a fresh headless child. The child process is the
 * isolation boundary: no extensions (no memory injection, no other spawn
 * tools), no context files, no persisted session, no MCP. */
export async function runGoldfish(
	params: GoldfishParams,
	opts: {
		runner?: Runner;
		root: string;
		signal?: AbortSignal;
		cwd?: string;
		onSpawn?: (killTree: () => void) => void;
		onChunk?: (chunk: string) => void;
	},
): Promise<{ report_path: string; summary: string }> {
	if (!(params.role in ROLE_TO_PERSONA)) {
		throw new Error(`unknown role: ${params.role}`);
	}
	const timeoutMinutes = Math.min(params.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES);
	const runner: Runner =
		opts.runner ??
		(async (task, runOpts) =>
			runProcess({
				binary: "pi",
				args: buildGoldfishArgv(task),
				cwd: opts.cwd,
				timeoutMs: timeoutMinutes * 60_000,
				signal: runOpts.signal,
				onSpawn: opts.onSpawn,
				onChunk: opts.onChunk,
			}));
	const task = buildGoldfishTask(params, opts.root);
	await acquire();
	let outcome: RunOutcome;
	try {
		outcome = await runner(task, { signal: opts.signal });
	} finally {
		release();
	}
	if (outcome.timedOut) {
		throw new Error(
			`goldfish review timed out after ${timeoutMinutes} minutes; no report accepted`,
		);
	}
	if (outcome.aborted) throw new Error("goldfish review aborted");
	if (outcome.exitCode !== 0) {
		throw new Error(`goldfish review exited ${outcome.exitCode}: ${outcome.stderr.slice(-500)}`);
	}
	const reportPath = await verifyReport(params.report_path);
	return { report_path: reportPath, summary: outcome.stdoutRaw.trim().slice(-2_000) };
}

export function killAll(killFns: Array<() => void>): void {
	for (const kill of killFns) {
		try {
			kill();
		} catch {
			// a dead child's kill handle may throw; shutdown must not
		}
	}
}

// "task" is deliberately absent: it collides with task-list tools that have
// nothing to do with spawning sessions.
const SPAWN_SHAPED = /spawn|subagent|delegate/i;

export function isSpawnShaped(toolName: string): boolean {
	return SPAWN_SHAPED.test(toolName);
}

export function isEgmInvocation(text: string): boolean {
	return /^\/(egm-|skill:egm-)/.test(text.trim());
}

// Guard window: armed by /egm-* commands, /skill:egm-* invocations, and
// egm_goldfish calls; disarmed by the next non-EGM user input. A session-long
// arm would block the user's own subagent tools for unrelated work.
let guardArmed = false;
export function armGuard(): void {
	guardArmed = true;
}
export function disarmGuard(): void {
	guardArmed = false;
}
export function isGuardArmed(): boolean {
	return guardArmed;
}

// Counting semaphore: a freed slot is handed to exactly one waiter, and the
// waiter's permit is taken inside release() so no caller can slip past.
let active = 0;
const waiters: Array<() => void> = [];
const acquire = async (): Promise<void> => {
	if (active < MAX_CONCURRENT_GOLDFISH) {
		active += 1;
		return;
	}
	await new Promise<void>((resolve) => {
		waiters.push(() => {
			active += 1;
			resolve();
		});
	});
};
const release = (): void => {
	active -= 1;
	waiters.shift()?.();
};

export function registerGoldfish(pi: ExtensionAPI, root: string): { arm: () => void } {
	const goldfishTool: ToolDefinition<typeof Params, GoldfishDetails> = {
		name: "egm_goldfish",
		label: "EGM Goldfish review",
		description:
			"Run one Elephant-Goldfish Model review in a fresh zero-context child session (own process: no extensions, no memory, no context files). The only valid way to run an EGM Goldfish reviewer; never substitute a generic subagent tool, forked context breaks the methodology.",
		promptSnippet:
			"egm_goldfish: run one EGM Goldfish reviewer in a fresh isolated child session (fresh context by construction).",
		parameters: Params,
		async execute(_toolCallId, params, signal, onUpdate) {
			armGuard();
			let tail = "";
			const result = await runGoldfish(params, {
				root,
				signal,
				onSpawn: (killTree) => {
					killHandles.push(killTree);
				},
				onChunk: (chunk) => {
					tail = (tail + chunk).slice(-500);
					onUpdate?.({
						content: [{ type: "text", text: `reviewer output tail:\n${tail}` }],
						details: { tail },
					});
				},
			});
			return {
				content: [
					{
						type: "text",
						text: `Goldfish review complete. Report: ${result.report_path}\n${result.summary}`,
					},
				],
				details: { report_path: result.report_path },
			};
		},
	};
	pi.registerTool(goldfishTool);

	const killHandles: Array<() => void> = [];

	// Once an EGM flow starts, denylist spawn-shaped tools so a partially
	// compatible subagent extension cannot silently fork context into a
	// Goldfish. Denylist, not allowlist: oddly named tools can still slip
	// through, which the README records as residual risk.
	pi.on("input", (event) => {
		if (isEgmInvocation(event.text)) {
			armGuard();
			return undefined;
		}
		if (event.source === "extension") return undefined;
		if (isGuardArmed()) disarmGuard();
		return undefined;
	});

	// Once an EGM flow starts, denylist spawn-shaped tools so a partially
	// compatible subagent extension cannot silently fork context into a
	// Goldfish. Best-effort backstop: scoped to the guard window and blind to
	// oddly named tools (README records the residual risk). The tool's own
	// description is the primary control.
	pi.on("tool_call", (event) => {
		if (!isGuardArmed()) return undefined;
		if (event.toolName === "egm_goldfish") return undefined;
		if (isSpawnShaped(event.toolName)) {
			return {
				block: true,
				reason: `EGM session: run Goldfish reviewers with egm_goldfish, not ${event.toolName}`,
			};
		}
		return undefined;
	});

	pi.on("session_shutdown", () => {
		killAll(killHandles);
	});

	return {
		arm: armGuard,
	};
}
