import { runProcess, MAX_TIMEOUT_MINUTES } from "@estebanforge/pi-agents-shared";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type GoldfishThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface GoldfishParams {
	role: GoldfishRole;
	target: string;
	report_path: string;
	standards?: string[];
	goldfishContext?: string[];
	focus?: string;
	timeout_minutes?: number;
	/** pi model pattern the child session runs on; unset uses the session default. */
	model?: string;
	/** pi thinking level for the child; requires model. */
	thinking_level?: GoldfishThinkingLevel;
}

export interface RunOutcome {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	aborted: boolean;
	timedOut: boolean;
	stderr: string;
	stdoutRaw: string;
}

export type Runner = (task: string, opts: { signal?: AbortSignal; modelArgs?: string[] }) => Promise<RunOutcome>;

export const MAX_CONCURRENT_GOLDFISH = 3;
const DEFAULT_TIMEOUT_MINUTES = 15;

export const Params = Type.Object({
	role: Type.Union(
		Object.keys(ROLE_TO_PERSONA).map((r) => Type.Literal(r)),
		{ description: "Which EGM persona the fresh reviewer adopts." },
	),
	target: Type.String({ description: "Absolute path of the design document under review." }),
	report_path: Type.String({
		description: "Absolute path where the reviewer writes its full report before replying.",
	}),
	standards: Type.Optional(
		Type.Array(Type.String({ maxLength: 1024 }), {
			maxItems: 20,
			description: "Absolute paths of EGM document standards the reviewer must apply.",
		}),
	),
	goldfishContext: Type.Optional(
		Type.Array(Type.String({ maxLength: 1024 }), {
			maxItems: 20,
			description: "Absolute paths of baseline files to read before reviewing.",
		}),
	),
	focus: Type.Optional(
		Type.String({
			maxLength: 2000,
			description: "Optional narrowing instruction for this review.",
		}),
	),
	timeout_minutes: Type.Optional(
		Type.Number({
			minimum: 1,
			description: `Hard ceiling for the child review session. Default ${DEFAULT_TIMEOUT_MINUTES}, max ${MAX_TIMEOUT_MINUTES}.`,
		}),
	),
	thinking_level: Type.Optional(
		Type.Union(
			THINKING_LEVELS.map((l) => Type.Literal(l)),
			{ description: "pi thinking level for the reviewer child. Requires model." },
		),
	),
	model: Type.Optional(
		Type.String({
			description:
				"pi model pattern the reviewer child runs on (e.g. 'zai/glm-5.3-flash'). Use a provider-qualified pattern when several authenticated providers carry the same name; bare names are rejected as ambiguous. Unset: the pi settings default model. Reviewers rarely need a flagship model.",
		}),
	),
});

interface GoldfishDetails {
	report_path?: string;
	tail?: string;
}

export function buildGoldfishArgv(task: string, modelArgs?: string[]): string[] {
	const base = [
		"--no-extensions",
		"--no-context-files",
		"--no-session",
		"--no-mcp",
		"--no-skills",
		"--no-prompt-templates",
		"--exclude-tools",
		"edit",
	];
	if (modelArgs?.length) base.push(...modelArgs);
	base.push("-p", task);
	return base;
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

/** Model selection argv for the child, empty when neither is set. pi takes
 *  the thinking level as a separate --thinking flag; bare model names are
 *  rejected as ambiguous when several providers carry the same model. */
export function buildModelArgs(model?: string, thinkingLevel?: GoldfishThinkingLevel): string[] {
	const args: string[] = [];
	if (model) args.push("--model", model);
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	return args;
}

/** Run one Goldfish review in a fresh headless child. The child process is the
 * isolation boundary: no extensions (no memory injection, no other spawn
 * tools), no context files, no persisted session, no MCP, and the edit tool disabled
 * (reviewers produce reports via write, never in-place edits). */
export async function runGoldfish(
	params: GoldfishParams,
	opts: {
		runner?: Runner;
		root: string;
		signal?: AbortSignal;
		cwd?: string;
		onSpawn?: (killTree: () => void) => void;
		onSettle?: (killTree: () => void) => void;
		onChunk?: (chunk: string) => void;
	},
): Promise<{ report_path: string; summary: string }> {
	if (!(params.role in ROLE_TO_PERSONA)) {
		throw new Error(`unknown role: ${params.role}`);
	}
	if (params.timeout_minutes !== undefined && !(params.timeout_minutes > 0)) {
		throw new Error(`timeout_minutes must be positive (got ${params.timeout_minutes})`);
	}
	if (opts.signal?.aborted) throw new Error("goldfish review aborted");
	const modelArgs = buildModelArgs(params.model, params.thinking_level);
	const timeoutMinutes = Math.min(params.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES);
	let runKill: (() => void) | undefined;
	const runner: Runner =
		opts.runner ??
		(async (task, runOpts) =>
			runProcess({
				binary: "pi",
				args: buildGoldfishArgv(task, runOpts.modelArgs),
				cwd: opts.cwd,
				timeoutMs: timeoutMinutes * 60_000,
				signal: runOpts.signal,
				onSpawn: (killTree) => {
					runKill = killTree;
					opts.onSpawn?.(killTree);
				},
				onChunk: opts.onChunk,
			}));
	const task = buildGoldfishTask(params, opts.root);
	await acquire();
	let outcome: RunOutcome;
	try {
		if (opts.signal?.aborted) throw new Error("goldfish review aborted");
		outcome = await runner(task, { signal: opts.signal, modelArgs });
	} finally {
		release();
	}
	if (runKill) opts.onSettle?.(runKill);
	if (outcome.timedOut) {
		throw new Error(
			`goldfish review timed out after ${timeoutMinutes} minutes; no report accepted`,
		);
	}
	if (outcome.aborted) throw new Error("goldfish review aborted");
	if (outcome.exitCode !== 0 || outcome.signal) {
		const tail = outcome.signal ? `killed by ${outcome.signal}` : outcome.stderr.slice(-500);
		throw new Error(`goldfish review failed: ${tail}`);
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

/** True when a serialized tool-call input touches an EGM artifact inside the
 *  package (skills, personas, standards, PI.md). Reading these is what an
 *  EGM flow looks like from outside, so it is what arms the guard. */
export function isEgmArtifactTouch(serializedInput: string, root: string): boolean {
	const markers = [`${root}/skills/egm-`, `${root}/PI.md`, `${root}/agents/`, `${root}/resources/`];
	return markers.some((marker) => serializedInput.includes(marker));
}

// Guard arm state is session-wide: once EGM artifacts are touched it stays
// armed until the session ends. EGM flows are multi-turn with interleaved
// plain answers, so input-based disarming drops the guard mid-flow.
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
			"Run one Elephant-Goldfish Model review in a fresh zero-context child session (own process: no extensions, no memory, no context files; the edit tool is disabled in the child). The only valid way to run an EGM Goldfish reviewer; never substitute a generic subagent tool, forked context breaks the methodology. Set model (and optionally thinking_level) to run the reviewer on a cheaper model; reviewers rarely need the flagship.",
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
					killHandles.add(killTree);
				},
				onSettle: (killTree) => {
					killHandles.delete(killTree);
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

	const killHandles = new Set<() => void>();

	// Once an EGM flow starts, denylist spawn-shaped tools so a partially
	// compatible subagent extension cannot silently fork context into a
	// Goldfish. Best-effort backstop, armed for the rest of the session once
	// EGM artifacts are touched (reads of skills/PI.md/agents/resources, an
	// egm_goldfish call, or an /egm-* command): EGM flows are multi-turn with
	// interleaved plain answers, so input-based disarming would drop the
	// guard mid-flow, and anything narrower is theater. Oddly named tools can
	// still slip through; README records that residual risk. The tool's own
	// description is the primary control.
	pi.on("tool_call", (event) => {
		if (!isGuardArmed()) {
			if (isEgmArtifactTouch(JSON.stringify(event.input ?? {}), root)) {
				armGuard();
				return undefined;
			}
			return undefined;
		}
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
		killAll([...killHandles]);
	});

	return {
		arm: armGuard,
	};
}
