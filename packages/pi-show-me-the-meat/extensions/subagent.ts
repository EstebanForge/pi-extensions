/**
 * pi-show-me-the-meat sub-agent wrapper. Spawns an isolated, in-memory AgentSession
 * that reads the numbered diff, explores the repo with read/grep if it needs to,
 * and calls a `submit` tool with a remove/replace/fold edit plan. The wrapper
 * validates the plan IN the submit tool: an invalid plan is returned to the
 * model as a tool error so it can repair within the turn budget, instead of
 * failing the whole run after the session is disposed.
 *
 * Why a sub-agent and not the main agent: the full diff plus the whole abridging
 * conversation live in the sub-agent's ephemeral session, which is disposed when
 * done. The main agent only receives the compiled reading diff. Context stays
 * clean. And because the sub-agent reuses the parent's model runtime, it runs on
 * whatever provider the user configured: Claude, GPT, Gemini, GLM, Ollama, anything.
 */
import {
	createAgentSession,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

import { compilePlan, type Submission, type LineRange, type LineReplacement, type LineFold } from "./compiler.js";
import { buildTask } from "./rubric.js";

type ThinkingLevel = NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]>;

/** Cap runaway exploration. Plenty for a few read/grep calls plus submit retries. */
const MAX_TURNS = 12;
/** Wall-clock cap on the whole sub-agent run, independent of the turn budget. */
const TIMEOUT_MS = 120_000;

export interface AbridgeOptions {
	cwd: string;
	/** The raw (unguttered) chunk; used to validate the plan inside submit. */
	rawDiff: string;
	numberedDiff: string;
	totalLines: number;
	model: Model<any> | undefined;
	thinkingLevel?: ThinkingLevel;
	signal?: AbortSignal;
}

/** Normalize a model-emitted range to {start,end}, tolerating [s,e] tuples. */
function asRange(r: { start: number; end: number } | [number, number]): LineRange {
	return Array.isArray(r) ? { start: r[0], end: r[1] } : { start: r.start, end: r.end };
}

/**
 * Run the abridging sub-agent and return its validated edit plan. Throws visibly
 * if the sub-agent finishes without submitting a valid plan, times out, or if no
 * model/auth is configured.
 */
export async function abridgeViaSubagent(opts: AbridgeOptions): Promise<Submission> {
	const { cwd, rawDiff, numberedDiff, totalLines, model, thinkingLevel, signal } = opts;

	if (!model) {
		throw new Error("meat: no model configured. Select a model in Pi before running meat.");
	}

	let plan: Submission | null = null;
	let resolveSubmit!: () => void;
	const submitted = new Promise<void>((resolve) => {
		resolveSubmit = resolve;
	});

	const submitTool: ToolDefinition = {
		name: "submit",
		label: "Submit edit plan",
		description:
			"Submit your final edit plan against the numbered ORIGINAL diff plus a one-line summary. " +
			"Every line you do not mention is kept verbatim. remove = drop lines; fold = collapse >=2 " +
			"same-polarity lines into one machine-generated ... row; replace = elide within one line (new " +
			"may only delete spans from old, marking each with ... or …). Imports are removed automatically. " +
			"The compiler validates your plan locally and returns any error here so you can fix and resubmit.",
		parameters: Type.Object({
			remove: Type.Array(
				Type.Object({
					start: Type.Integer({ description: "start line (1-indexed, inclusive)" }),
					end: Type.Integer({ description: "end line (inclusive)" }),
				}),
				{
					description:
						"Inclusive 1-based ranges of original diff lines to drop. Coordinates never shift. Use [] when empty.",
				},
			),
			replace: Type.Array(
				Type.Object({
					line: Type.Integer({ description: "1-indexed source line to elide within" }),
					old: Type.String({ description: "Exact span on that line (after the +//-/ marker) to replace." }),
					new: Type.String({ description: "Deletion-only projection of old; mark each gap with ... or …." }),
				}),
				{ description: "Single-line elisions. Use [] when empty." },
			),
			fold: Type.Array(
				Type.Object({
					start: Type.Integer({ description: "start line (1-indexed, inclusive)" }),
					end: Type.Integer({ description: "end line (inclusive)" }),
				}),
				{
					description:
						"Ranges of >=2 same-polarity hunk source lines to collapse into one indentation-preserving ... row. Use [] when empty.",
				},
			),
			summary: Type.String({ description: "One-line summary of what the change does." }),
		}),
		async execute(_toolCallId, params) {
			if (plan) {
				return {
					content: [{ type: "text", text: "A valid plan was already accepted; nothing more to do." }],
					details: { alreadyAccepted: true },
				};
			}
			const p = params as {
				remove: Array<LineRange | [number, number]>;
				replace: LineReplacement[];
				fold: Array<LineFold | [number, number]>;
				summary: string;
			};
			const candidate: Submission = {
				remove: (p.remove ?? []).map(asRange),
				replace: p.replace ?? [],
				fold: (p.fold ?? []).map(asRange),
				summary: String(p.summary ?? ""),
			};
			// Validate locally before accepting: a bad plan goes back to the model as
			// a tool error so it can repair, instead of killing the run post-dispose.
			try {
				compilePlan(rawDiff, candidate);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `That plan did not compile: ${msg}\nFix it and call submit again with corrected coordinates.`,
						},
					],
					details: { rejected: true },
				};
			}
			plan = candidate;
			resolveSubmit();
			return {
				content: [{ type: "text", text: "Edit plan accepted. The compiler will project it faithfully." }],
				details: { removeCount: plan.remove.length, replaceCount: plan.replace.length, foldCount: plan.fold.length },
			};
		},
	};

	const { session } = await createAgentSession({
		cwd,
		model,
		// Default to thinking-off for the sub-agent: some providers reject the
		// thinking param and the abridge task is high-quality without it.
		thinkingLevel: thinkingLevel ?? ("off" as ThinkingLevel),
		// Allowlist is the control: only read, grep, and our submit are active.
		// Every other tool (including this extension's own meat tool) is filtered
		// out, so the sub-agent cannot recurse or wander into write/edit/bash.
		tools: ["read", "grep", "submit"],
		customTools: [submitTool],
		sessionManager: SessionManager.inMemory(cwd),
	});

	let turns = 0;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "turn_end") {
			turns += 1;
			if (turns >= MAX_TURNS) session.abort().catch(() => {});
		}
	});

	const onAbort = () => session.abort().catch(() => {});
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		const task = buildTask(numberedDiff, totalLines);
		const promptPromise = session.prompt(task).catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`meat sub-agent failed to start: ${msg}`);
		});
		// Promise.race does not observe losing promises; attach a permanent no-op
		// handler so a late rejection cannot surface as an unhandled rejection.
		promptPromise.catch(() => {});

		let timedOut = false;
		const timeout = new Promise<void>((resolve) => {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				resolve();
			}, TIMEOUT_MS);
		});
		await Promise.race([promptPromise, submitted, timeout]);

		if (timedOut && !plan) {
			await session.abort().catch(() => {});
			throw new Error(`meat sub-agent timed out after ${TIMEOUT_MS / 1000}s without submitting a valid plan`);
		}
		if (plan && session.isStreaming) await session.abort().catch(() => {});
		await session.waitForIdle().catch(() => {});
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		unsubscribe();
		if (signal) signal.removeEventListener("abort", onAbort);
		session.dispose();
	}

	if (!plan) {
		throw new Error("meat: sub-agent finished without calling submit with a valid edit plan.");
	}
	return plan;
}
