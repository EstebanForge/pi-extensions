// The AskAntigravity tool: delegate a self-contained sub-task to Google
// Antigravity's `agy` CLI. Ported from pi-ask-antigravity v1.1.0 so this
// extension (pi-antigravity-bridge) provides BOTH the streaming provider AND
// the one-shot delegation tool - the same shape as pi-claude-bridge.
//
// One self-contained tool. Spawns `agy -p`, streams its stdout as partial
// output, returns the final response. agy runs its OWN tool loop (read,
// write, edit, exec) inside the workspace.
//
// When both pi-antigravity-bridge and pi-ask-antigravity are installed, the
// bridge wins: pi-ask-antigravity detects the bridge package and registers
// nothing (see its defer guard). This module is the single source of truth.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { contentText, type ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	buildAgyArgs,
	buildFinalPrompt,
	CONVERSATIONS_DIR,
	CONV_ID_RE,
	filterHiddenModels,
	mergeCatalog,
	newConversationId,
	parseModelLine,
	resolveAgyModel,
	snapshotConversations,
	type ModelEntry,
	type Mode,
} from "@estebanforge/pi-ask-shared";
import { loadConfig, type AgyMode, type ThinkingTier } from "./config.js";
import { redactText } from "./redact.js";
import { acquireBridgeSuppression } from "./mcp-registration.js";
import { AGY_EFFORT_ORDER, spawnAgyModelsRaw, toAgyEffort } from "./models.js";
import { sweepStaleWebAgents, webAgentsRoot } from "./web-tools.js";

// --- Constants -------------------------------------------------------------

const AGY_DESCRIPTION = `Delegate a self-contained sub-task to Google Antigravity. agy is the CLI for Gemini, so this tool is reached under three equivalent names the user may use interchangeably: **gemini**, **antigravity**, and **agy**. When the user says "ask gemini", "ask antigravity", "ask agy", or otherwise refers to any of these, call THIS tool. agy runs its OWN tool loop: it can read, write, edit, and execute inside the workspace, then returns its final answer. Use for a second opinion from a different model family, Gemini-specific reasoning, or isolated sub-tasks you do not need to drive step-by-step. Provide a complete, self-contained task description; agy will not see this conversation.

TWO MODES (you choose):
- **One-shot (isolated)**: omit conversationId. agy starts fresh with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the conversationId returned in the PREVIOUS call's details (details.conversationId). agy resumes that conversation with full context intact.

EXECUTION MODES (param: mode):
- **plan**: agy proposes a plan for review-shaped tasks. NOT a security boundary: the CLI does not gate writes under plan mode (upstream google-antigravity/antigravity-cli#1181, probed 2026-10-07: the write can execute in the same turn). The run additionally stages a temporary restricted agent whose toolset has no file-editing tools, as a damper, and the skip-permissions flag is never passed. Inline the material to review - a plan run cannot fetch it.
- **accept-edits**: agy applies edits directly inside the workspace. Default unless the configured mode is plan.

COMPACT OUTPUT (param: digest): when true, the prompt is prefixed to request compact digests instead of full file contents. Defaults on for plan, off for accept-edits.

THINKING LEVEL (params: thinking, effort - SYNONYMS for one knob):
- pi calls it thinking, agy calls it effort. Same thing. Pass ONE of the two.
- Values (pi vocabulary): minimal|low|medium|high|xhigh|max. Clamped to agy's low|medium|high; unknown values fall back to low. "peer review on high thinking" -> thinking: "high".
- An explicit level beats a tier embedded in model ("flash high") and the configured default. Omit both for the configured default.`;

const DEFAULT_TIMEOUT_MIN = 10;
const GRACE_AFTER_TIMEOUT_MS = 5000;
const STATUS_INTERVAL_MS = 1000;
const STATUS_TAIL_CHARS = 160;

// renderCall / renderResult preview limits (match pi-claude-bridge).
const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;
const DISCOVERY_POLL_ATTEMPTS = 5;
const DISCOVERY_POLL_MS = 100;

/** Parse raw `agy models` text into tool-catalog entries: the shared line
 *  grammar + hidden-family filter + static sonnet/opus overlay. Pure: no
 *  spawn. */
export function toolModelsFromRaw(raw: string): ModelEntry[] {
	return mergeCatalog(
		filterHiddenModels(
			raw
				.split("\n")
				.map(parseModelLine)
				.filter((e): e is ModelEntry => e !== null),
		),
	);
}

/** Query `agy models` and return tool-catalog entries. Returns [] on failure.
 *  Kept for standalone use; the extension entry spawns once and parses via
 *  toolModelsFromRaw to avoid a second `agy models` invocation. */
export async function discoverToolModels(binary: string): Promise<ModelEntry[]> {
	return toolModelsFromRaw(await spawnAgyModelsRaw(binary));
}

function extraArgs(): string[] {
	const raw = process.env.AGY_EXTRA_ARGS;
	return raw ? raw.split(/\s+/).filter((s) => s.length > 0) : [];
}

// --- Prompt assembly: shared peer adapter ----------------------------------
// PLAN_HEADLESS_GUARD / AGENT_REVIEW_GUARD / buildFinalPrompt live in
// pi-ask-shared (peers/antigravity.ts); the bridge inherits the identical
// guard discipline. Re-exported for the bridge's own tests.
export { AGENT_REVIEW_GUARD, buildFinalPrompt, PLAN_HEADLESS_GUARD } from "@estebanforge/pi-ask-shared";

// --- Plan-mode reviewer agent ----------------------------------------------

/** Temp agent dirs share the ~/.gemini/config/agents discovery root with the
 *  web delegates; AGY_AGENTS_ROOT overrides for tests and sandboxes. */
export function askAgentsRoot(): string {
	return process.env.AGY_AGENTS_ROOT ?? webAgentsRoot();
}

const ASK_AGENT_PREFIX = "pi-bridge-ask-";
const ASK_AGENT_TOOLS = ["view_file", "run_command"];

/** agent.md for the plan-mode reviewer. The tools list is a damper, not a
 *  guarantee: with no file-editing tool present the model has no edit tool in
 *  its menu (probed 2026-09-28 on agy 1.2.12: the toolset reports "none" for
 *  edits; re-verify on 1.3.x), but the CLI itself does not enforce
 *  review-only under plan mode (upstream google-antigravity/antigravity-cli
 *  #1181, probed 2026-10-07: the write can execute in the same turn).
 *  commandExecutionPolicy auto is what lets read commands run headless with
 *  no user allow rules. Never add a write-capable tool here. */
export function reviewerAgentMd(name: string): string {
	return [
		"---",
		`name: ${name}`,
		"description: Temporary Pi plan-mode reviewer",
		"mainAgent: true",
		"subagent: false",
		"model: inherit",
		"excludeDefaultComponents: true",
		"inheritCustomizations: false",
		"inheritMcp: false",
		"commandExecutionPolicy: auto",
		"tools:",
		...ASK_AGENT_TOOLS.map((t) => `  - ${t}`),
		"skills: []",
		"rules: []",
		"agents: []",
		"mcpServers: []",
		"---",
		"",
		"You are a strict read-only code reviewer. Review, analyze, and plan; never modify anything.",
		"",
	].join("\n");
}

/** Stage one unique reviewer agent (agent.md + pid marker) under root. Same
 *  hygiene doctrine as the web delegates: nonce-named, cleaned in finally,
 *  orphans swept by pid marker at registration. */
export function stageReviewerAgent(root: string): { name: string; dir: string } {
	fs.mkdirSync(root, { recursive: true });
	const name = `${ASK_AGENT_PREFIX}${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(dir, "agent.md"), reviewerAgentMd(name), { mode: 0o600 });
	fs.writeFileSync(path.join(dir, ".pid"), `${process.pid}\n`, { mode: 0o600 });
	return { name, dir };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Registration ----------------------------------------------------------

/** Register the AskAntigravity tool. Call once from the extension entry.
 *  `entries` is the merged live+overlay catalog discovered at load. */
export async function registerAskAntigravityTool(
	pi: ExtensionAPI,
	entries: ModelEntry[],
	/** Daily file log sink (src/daily-log.ts). Records lifecycle, never
	 *  prompt text. Level matches DailyLogger: debug is the AGY_DEBUG-only
	 *  verbose tier; info/warn/error always land. */
	log?: (event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error") => void,
): Promise<void> {
	// Orphan sweep for the plan-mode reviewer agents (SIGKILL can skip the
	// run's finally): same pid-marker doctrine as the web delegates.
	try {
		sweepStaleWebAgents(askAgentsRoot(), Date.now(), ASK_AGENT_PREFIX);
	} catch {
		// a sweep failure must never block registration
	}
	pi.registerTool({
		name: "AskAntigravity",
		label: "Ask Antigravity",
		description: AGY_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained task for agy. Include all context agy needs; it cannot see this conversation.",
			}),
			cwd: Type.Optional(
				Type.String({
					description: "Absolute workspace path agy runs in. Defaults to the current project root.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Model alias or exact id. Friendly: 'flash', 'pro', 'gemini'. Add a tier: 'flash high'. Pin a version: '3.5 flash'. Exact: 'gemini-3.6-flash-medium'. Omit for the configured default.",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"Thinking level (= agy effort tier). pi vocabulary: minimal|low|medium|high|xhigh|max, clamped to agy's low|medium|high (unknown values fall back to low). Overrides a tier embedded in `model`. Omit for the configured default.",
				}),
			),
			effort: Type.Optional(
				Type.String({
					description:
						"Alias for `thinking` (agy's own name for the same knob). Pass ONE of the two; different values on both is an error.",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("plan"), Type.Literal("accept-edits")], {
					description:
						"agy execution mode. 'plan' = plan-shaped run: the CLI does not enforce review-only (see the tool description); the staged reviewer agent's toolset omits file-editing tools as a damper. 'accept-edits' = agy applies edits. Omit to follow the configured default (plan when config mode is plan, else accept-edits).",
				}),
			),
			digest: Type.Optional(
				Type.Boolean({
					description:
						"Request compact digests instead of full file contents. Defaults on for plan, off for accept-edits.",
				}),
			),
			conversationId: Type.Optional(
				Type.String({
					description:
						"Omit for a one-shot. To CONTINUE a previous agy conversation, pass the conversationId returned in that call's details.",
				}),
			),
			timeoutMinutes: Type.Optional(
				Type.Number({ description: `Hard cap on the agy run in minutes. Default ${DEFAULT_TIMEOUT_MIN}.` }),
			),
			includeContext: Type.Optional(
				Type.Boolean({
					description:
						"When true, export the current pi conversation (resolved, as markdown) to a temp file inside the workspace and tell agy to read it first. Default false (isolated one-shot). Opt in only when the user explicitly wants agy to see the full conversation; it costs agy tokens to read.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"NOT supported by this tool. The bridge runs agy through its own delegated flow and the answer must return synchronously to the caller. For background runs use the standalone @estebanforge/pi-ask-antigravity extension. Calls with background=true are refused.",
				}),
			),
		}),
		renderCall(args, theme, _context) {
			// Show RESOLVED model/thinking/mode (config defaults applied) so the
			// row identifies what will actually run, not just explicit args.
			const cfg = loadConfig();
			const requestedModel = (args.model as string | undefined)?.trim() || cfg.defaultModel;
			const thinkingArg = (args.thinking as string | undefined) ?? (args.effort as string | undefined);
			const resolved =
				resolveAgyModel(
					requestedModel,
					entries,
					cfg.defaultThinking,
					thinkingArg ? toAgyEffort(thinkingArg as ThinkingLevel, AGY_EFFORT_ORDER) : undefined,
				) ?? { model: requestedModel };
			const thinking: ThinkingTier = resolved.effort ?? cfg.defaultThinking;
			// Same default rule as execute: plan when the configured mode is
			// plan, so the row always names what will actually run.
			const mode: AgyMode =
				(args.mode as AgyMode | undefined) ?? (cfg.mode === "plan" ? "plan" : "accept-edits");
			const useDigest = typeof args.digest === "boolean" ? args.digest : mode === "plan";
			const isContinue =
				typeof args.conversationId === "string" && CONV_ID_RE.test(args.conversationId);

			const tags: string[] = [`model=${resolved.model}`, `thinking=${thinking}`];
			if (mode !== "accept-edits") tags.push(`mode=${mode}`);
			if (useDigest) tags.push("digest");
			if (isContinue) tags.push("continue");
			if (args.includeContext) tags.push("context=full");

			let text = theme.fg("mdLink", theme.bold("AskAntigravity "));
			text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;

			const prompt = String(args.prompt ?? "");
			const truncated = prompt.length > PREVIEW_MAX_CHARS ? prompt.slice(0, PREVIEW_MAX_CHARS) : prompt;
			const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
			text += theme.fg("muted", `"${lines.join("\n")}"`);
			if (prompt.length > PREVIEW_MAX_CHARS || prompt.split("\n").length > PREVIEW_MAX_LINES) {
				text += theme.fg("dim", " …");
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const d = result.details as AgyDetails | undefined;
			if (isPartial) {
				const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
				return new Text(theme.fg("mdLink", "◉ AskAntigravity ") + theme.fg("muted", status), 0, 0);
			}

			const body = result.content[0]?.type === "text" ? result.content[0].text : "";
			const errored =
		d?.exitCode !== 0 || !!d?.aborted || !!d?.timedOut || !!d?.empty;

			let text = errored
				? theme.fg("error", "✗ AskAntigravity error")
				: theme.fg("mdLink", "✓ AskAntigravity");

			const rTags: string[] = [];
			if (d?.resolvedModel || d?.model) rTags.push(`model=${d?.resolvedModel ?? d?.model}`);
			if (d?.thinking) rTags.push(`thinking=${d.thinking}`);
			if (d?.mode && d.mode !== "accept-edits") rTags.push(`mode=${d.mode}`);
			if (d?.includeContext) rTags.push("context=full");
			if (rTags.length) text += ` ${theme.fg("accent", `[${rTags.join(", ")}]`)}`;
			if (d?.durationMs) text += ` ${theme.fg("dim", `${(d.durationMs / 1000).toFixed(1)}s`)}`;

			if (expanded) {
				if (body) text += `\n${theme.fg("toolOutput", body)}`;
			} else {
				const truncated = body.length > PREVIEW_MAX_CHARS ? body.slice(0, PREVIEW_MAX_CHARS) : body;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
				if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) {
					text += `\n${theme.fg("dim", `… (${keyHint("app.tools.expand", "to expand")})`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Circular-delegation guard: refuse if already running through the
			// antigravity provider.
			if (ctx.model?.provider === "antigravity" || ctx.model?.provider === "agy") {
				return {
					content: [
						{
							type: "text",
							text: "Error: AskAntigravity cannot be used when the active provider is already antigravity - you're already running through it.",
						},
					],
					details: emptyDetails(),
				};
			}

			const config = loadConfig();
			// readOnly refusal (fail-closed): the kill switch covers this tool too.
			// It must not be bypassable with an explicit mode param: the CLI has no
			// review-only enforcement (upstream google-antigravity/antigravity-cli
			// #1181), so a plan-labeled run here is not read-only.
			if (config.readOnly) {
				return {
					content: [
						{
							type: "text",
							text: 'readOnly is on: AskAntigravity is refused (fail-closed; the agy CLI has no review-only enforcement, google-antigravity/antigravity-cli#1181). Run /agy readonly off to use this tool.',
						},
					],
					details: emptyDetails(),
				};
			}
			// Background refusal (fail-closed): a wake from this tool would land in
			// the pi session even when the CALLER is agy (nested delegation via the
			// bridge catalog), and the bridge already owns an async delegation flow
			// (early-ack + bridge_poll_result). The standalone pi-ask-antigravity
			// extension is the background-capable tool.
			if (params.background) {
				return {
					content: [
						{
							type: "text",
							text: 'background is not supported by the bridge\'s AskAntigravity: the answer must return synchronously to the caller. Long delegations are already covered by the bridge\'s own async flow (early-ack + bridge_poll_result); for an unattended peer run, launch agy directly in a terminal instead. Call again without background.',
						},
					],
					details: emptyDetails(),
				};
			}
			const requestedModel = (params.model as string | undefined) ?? config.defaultModel;
			if (typeof params.model === "string" && params.model.trim().startsWith("-")) {
				return {
					content: [
						{
							type: "text",
							text: `model value "${params.model}" starts with "-" - not a valid model id.`,
						},
					],
					details: emptyDetails(requestedModel),
				};
			}
			if (
				typeof params.thinking === "string" &&
				typeof params.effort === "string" &&
				params.thinking !== params.effort
			) {
				return {
					content: [
						{
							type: "text",
							text: "thinking and effort are synonyms for the same knob - pass one, not both with different values.",
						},
					],
					details: emptyDetails(requestedModel),
				};
			}
			const thinkingArg = (params.thinking as string | undefined) ?? (params.effort as string | undefined);
			const preferredTier = thinkingArg
				? toAgyEffort(thinkingArg as ThinkingLevel, AGY_EFFORT_ORDER)
				: undefined;
			const resolved =
				resolveAgyModel(requestedModel, entries, config.defaultThinking, preferredTier) ?? {
					model: requestedModel,
				};

			const start = Date.now();
			const cwd = params.cwd || ctx.cwd || process.cwd();
			try {
				const stat = fs.statSync(cwd);
				if (!stat.isDirectory()) {
					return {
						content: [{ type: "text", text: `cwd is not a directory: ${cwd}` }],
						details: emptyDetails(requestedModel, resolved.model),
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `cwd does not exist: ${cwd}` }],
					details: emptyDetails(requestedModel, resolved.model),
				};
			}

			const timeoutMin = params.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN;

			const rawConvId = params.conversationId;
			const isContinuation =
				typeof rawConvId === "string" && rawConvId.length > 0 && CONV_ID_RE.test(rawConvId);
			const snapshot = isContinuation ? null : snapshotConversations(CONVERSATIONS_DIR);

			const mode: AgyMode =
				(params.mode as AgyMode | undefined) ?? (config.mode === "plan" ? "plan" : "accept-edits");
			// Plan runs stage a restricted reviewer agent: its tools list has NO
			// file-editing tool, a toolset-level damper on edits (the prompt
			// guard alone was observed failing once - a sub-agent still edited
			// files; the CLI itself does not enforce review-only, upstream
			// #1181).
			// Staging failure degrades to the legacy fallback: no agent, no skip
			// flag, the stricter command-forbidding guard.
			let reviewerAgent: { name: string; dir: string } | null = null;
			if (mode === "plan") {
				try {
					reviewerAgent = stageReviewerAgent(askAgentsRoot());
				} catch {
					reviewerAgent = null;
				}
			}
			const useDigest: boolean =
				typeof params.digest === "boolean" ? params.digest : mode === "plan";
			const finalPrompt: string = buildFinalPrompt(
				params.prompt,
				mode,
				useDigest,
				reviewerAgent !== null,
			);

			// Opt-in full-context export (isolated stays the default).
			let contextFile: string | null = null;
			if (params.includeContext) {
				try {
					const { messages } = buildSessionContext(ctx.sessionManager.getBranch());
					if (messages.length) {
						const md = renderAgentMessagesMarkdown(messages);
						const ctxDir = askContextDir();
						fs.mkdirSync(ctxDir, { recursive: true });
						contextFile = path.join(
							ctxDir,
							`.ask-context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
						);
						fs.writeFileSync(contextFile, md, { mode: 0o600 });
					}
				} catch {
					contextFile = null;
				}
			}
			const effectivePrompt = contextFile
				? `The full pi conversation context (as markdown) is at: ${contextFile}\nRead that file first for context, then do the task below.\n\n---\n\n${finalPrompt}`
				: finalPrompt;

			log?.(
				"ask-start",
				{ model: resolved.model, thinking: resolved.effort ?? config.defaultThinking, mode, digest: useDigest, continue: isContinuation, timeoutMin },
				"info",
			);
			// Build argv via the shared peer adapter (see buildAgyArgs there for
			// the flag-order contract and the fail-closed plan-run rules). The
			// bridge's permissions gate is truthy (`!== false`), so an unset
			// config counts as enabled - same knob as the provider.
			const args = buildAgyArgs({
				cwd,
				resolved,
				mode,
				reviewerAgentName: reviewerAgent?.name ?? null,
				skipPermissions: config.skipPermissions !== false,
				conversationId: isContinuation ? (rawConvId as string) : null,
				timeoutMinutes: timeoutMin,
				addDirs: contextFile ? [askContextDir()] : [],
				extraArgs: extraArgs(),
				prompt: effectivePrompt,
			});

			const details: AgyDetails = {
				model: requestedModel,
				resolvedModel: resolved.model,
				thinking: resolved.effort ?? config.defaultThinking,
				mode,
				digest: useDigest,
				conversationId: isContinuation ? (rawConvId as string) : null,
				includeContext: contextFile !== null,
				exitCode: 0,
				aborted: false,
				timedOut: false,
				durationMs: 0,
				stderr: "",
			};

			const binary = process.env.AGY_BIN || "agy";
			let out = "";

			// Delegation isolation: any agy on this machine discovers MCP servers
			// from the global mcp_config.json, so this spawned `agy -p` would find
			// live pi-bridge-* entries and call tools the host bridge cannot serve
			// outside a live provider turn ("no active antigravity turn"). agy also
			// WATCHES that file (ReloadMcpConfig): re-enabling mid-run pokes the live
			// delegation to reconnect. The old 5s grace timer did exactly that -
			// observed live 2026-09-09 as a call-tool-fail ~50s into a delegation -
			// so the entries now stay hidden for the WHOLE delegated run. The release
			// fires only on process close/error (cleanup + finally below); if pi
			// itself dies first, session start heals the file
			// (healBridgeSuppression in extensions/index.ts, marker-aware). Cross-
			// process coordination rides the suppression marker in mcp-registration.
			// Refcounted, so overlapping delegations in this process cannot release
			// each other's window early. A refused config fail-opens to the status quo.
			const restoreBridge = acquireBridgeSuppression();

			const statusInterval = onUpdate
				? setInterval(() => {
						const elapsed = Math.floor((Date.now() - start) / 1000);
						const tail = out.slice(-STATUS_TAIL_CHARS);
						const text = tail ? `(running ${elapsed}s)\n…${tail}` : `(running ${elapsed}s)`;
						onUpdate({
							content: [{ type: "text", text }],
							details: { ...details, durationMs: Date.now() - start },
						});
					}, STATUS_INTERVAL_MS)
				: null;

			try {
				// Bind the conversation id DURING the run (agy is alive then) so the
				// pid-based /proc FD resolver can disambiguate when a concurrent agy
				// also drops a new .db. Awaited after the run; the post-exit loop
				// below is the fallback for runs that exit before the poll binds.
				let bindDuringRun: Promise<void> = Promise.resolve();
				const outcome = await new Promise<{
					exitCode: number;
					aborted: boolean;
					timedOut: boolean;
				}>((resolveP, rejectP) => {
					const proc = spawn(binary, args, {
						cwd,
						stdio: ["ignore", "pipe", "pipe"],
						shell: false,
						detached: true,
					});
					proc.stdout?.setEncoding("utf8");
					proc.stderr?.setEncoding("utf8");
					proc.stdout?.on("data", (d: string) => (out += d));
					proc.stderr?.on("data", (d: string) => (details.stderr += d));

					// Concurrent bind: poll for the new id while agy is alive. The FD
					// resolver needs a live process tree, so this stops (and the post-
					// exit fallback below takes over) once agy has exited.
					if (!isContinuation && snapshot && proc.pid) {
						bindDuringRun = (async () => {
							for (let attempt = 0; attempt < DISCOVERY_POLL_ATTEMPTS; attempt++) {
								if (details.conversationId) return;
								if (proc.exitCode !== null) return; // agy gone: scan useless now
								const found = newConversationId(CONVERSATIONS_DIR, snapshot, {
									pid: proc.pid,
								});
								if (found) {
									details.conversationId = found;
									return;
								}
								await sleep(DISCOVERY_POLL_MS);
							}
						})().catch(() => {
							/* best-effort: a bind error must never fail an otherwise-OK turn */
						});
					}

					let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
					let watchdog: ReturnType<typeof setTimeout> | undefined;
					let settled = false;
					let timedOut = false;

					const killTree = () => {
						try {
							if (proc.pid) process.kill(-proc.pid, "SIGTERM");
						} catch {
							/* process group already gone */
						}
						if (!sigkillTimer) {
							sigkillTimer = setTimeout(() => {
								try {
									if (proc.pid) process.kill(-proc.pid, "SIGKILL");
								} catch {
									/* give up */
								}
							}, GRACE_AFTER_TIMEOUT_MS);
						}
					};

					const cleanup = () => {
						if (watchdog) clearTimeout(watchdog);
						if (sigkillTimer) clearTimeout(sigkillTimer);
						if (signal) signal.removeEventListener("abort", onAbort);
						restoreBridge();
					};
					const onAbort = () => killTree();

					watchdog = setTimeout(() => {
						timedOut = true;
						killTree();
					}, timeoutMin * 60_000);

					if (signal) {
						if (signal.aborted) killTree();
						else signal.addEventListener("abort", onAbort, { once: true });
					}

					const finish = (code: number | null) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolveP({
							exitCode: code ?? 0,
							aborted: !!signal?.aborted,
							timedOut,
						});
					};

					proc.on("error", (err) => {
						cleanup();
						rejectP(err);
					});
					proc.on("close", finish);
					proc.on("exit", finish);
				});

				if (statusInterval) clearInterval(statusInterval);

				// Let the during-run bind poll finish (it bails immediately once agy
				// has exited, so this rarely blocks).
				await bindDuringRun;

				details.exitCode = outcome.exitCode;
				details.aborted = outcome.aborted;
				details.timedOut = outcome.timedOut;
				details.durationMs = Date.now() - start;
				const text = out.trim();
				log?.(
					"ask-end",
					{ exitCode: outcome.exitCode, aborted: outcome.aborted, timedOut: outcome.timedOut, empty: !text, durationMs: details.durationMs, conversationId: details.conversationId },
					outcome.exitCode !== 0 || outcome.aborted || outcome.timedOut || !text ? "warn" : "info",
				);

				if (!isContinuation && !details.conversationId && snapshot) {
					for (let attempt = 0; attempt < DISCOVERY_POLL_ATTEMPTS; attempt++) {
						const found = newConversationId(CONVERSATIONS_DIR, snapshot);
						if (found) {
							details.conversationId = found;
							break;
						}
						await sleep(DISCOVERY_POLL_MS);
					}
				}

				if (outcome.aborted) {
					return {
						content: [
							{
								type: "text",
								text: text
									? `agy was aborted. Partial output:\n\n${text}`
									: "agy was aborted before producing output.",
							},
						],
						details,
					};
				}

				if (outcome.timedOut) {
					const note = `agy exceeded the ${timeoutMin}m timeout and was killed`;
					return {
						content: [{ type: "text", text: text ? `${text}\n\n[${note}]` : note }],
						details,
					};
				}

				if (outcome.exitCode !== 0) {
					// stderr can carry auth material; the note is chat-visible.
					const stderr = redactText(details.stderr.trim());
					const note = stderr
						? `agy exited with status ${outcome.exitCode}: ${stderr}`
						: `agy exited with status ${outcome.exitCode}`;
					return {
						content: [{ type: "text", text: text ? `${text}\n\n[${note}]` : note }],
						details,
					};
				}

				// Exit 0 with nothing on stdout is still a failure for the
				// delegator: headless agy auto-denies a permission-gated tool call
				// (e.g. the command gate in plan mode), prints the reason only to
				// stderr, and ends cleanly. Falling through to the success path here
				// returned just the conversation footer, which read as an empty
				// success (silent-failure bug found 2026-09-25).
				if (!text) {
					details.empty = true;
					const stderr = redactText(details.stderr.trim());
					const note = [
						"agy exited cleanly but produced no output.",
						stderr ? `stderr: ${stderr}` : null,
						"Common cause: a tool call needed a permission that headless mode cannot prompt for (typically the command gate in plan mode), so it was auto-denied and the turn ended with no answer. Recovery: retry in plan mode with all needed content inlined in the prompt - plan runs cannot fetch it, commands are denied. Or rerun outside plan mode with skipPermissions, or add your own permissions.allow rules in ~/.gemini/antigravity-cli/settings.json.",
					]
						.filter(Boolean)
						.join(" ");
					return { content: [{ type: "text", text: note }], details };
				}

				onUpdate?.({ content: [{ type: "text", text: "" }], details: { ...details } });
				const footer = details.conversationId
					? `\n\n[agy conversationId: ${details.conversationId} - pass as conversationId to continue this conversation]`
					: "";
				return { content: [{ type: "text", text: text + footer }], details };
			} catch (err) {
				if (statusInterval) clearInterval(statusInterval);
				details.durationMs = Date.now() - start;
				const msg = err instanceof Error ? err.message : String(err);
				log?.("ask-fail", { error: msg, durationMs: details.durationMs }, "error");
				return { content: [{ type: "text", text: `failed to run agy: ${msg}` }], details };
			}
			finally {
				// Belt and braces: cleanup() already restores on close/error; this
				// covers paths that never reached the process (sync spawn throw).
				restoreBridge();
				if (contextFile) {
					try {
						fs.unlinkSync(contextFile);
					} catch {}
				}
				if (reviewerAgent) {
					try {
						fs.rmSync(reviewerAgent.dir, { recursive: true, force: true });
					} catch {}
				}
			}
		},
	});
}

// --- Full-context export (opt-in includeContext) --------------------------
// NOTE: duplicated per pi-ask-* / bridge package (each is self-contained).
// Duck-typed over role/content to tolerate AgentMessage's union + custom types.

// Tool-call inputs and tool-result bodies are clamped so the exported
// transcript stays reviewable; the agent can re-read any source file by path.
// User/assistant prose is kept in full (that IS the conversation).
const CONTEXT_BLOCK_MAX_CHARS = 2000;

function clampBlock(text: unknown, limit = CONTEXT_BLOCK_MAX_CHARS): string {
	const t = String(text ?? "");
	return t.length > limit ? `${t.slice(0, limit)}\n…[truncated, ${t.length - limit} more chars]` : t;
}

/** Render resolved pi AgentMessages to a readable markdown transcript.
 *  Pure: no IO. Caller writes the returned string to a temp file. */
function renderAgentMessagesMarkdown(messages: readonly unknown[]): string {
	const lines: string[] = [
		"# Pi conversation context",
		"",
		`_Exported for full-context delegation. ${messages.length} message(s)._`,
		"",
	];
	for (const raw of messages) {
		const m = raw as { role?: string; content?: unknown };
		const role = m.role ?? "message";
		const content = m.content;
		if (role === "assistant") {
			const blocks = (Array.isArray(content) ? content : []) as ReadonlyArray<{
				type: string;
				text?: string;
				name?: string;
				input?: unknown;
			}>;
			const text = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			if (text.trim()) lines.push("## Assistant", "", text, "");
			for (const b of blocks) {
				if (b.type === "toolCall" || b.type === "tool_use") {
					const input = clampBlock(
						typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? ""),
						500,
					);
					lines.push(`> tool call: ${b.name ?? "(unknown)"}(${input})`, "");
				}
			}
		} else if (role === "toolResult" || role === "tool_result" || role === "tool") {
			const text = contentText(content as any);
			if (text.trim()) lines.push("## Tool result", "", clampBlock(text), "");
		} else {
			const text = contentText(content as any);
			if (text.trim()) lines.push(`## ${role}`, "", clampBlock(text), "");
		}
	}
	return lines.join("\n");
}

/** Centralized scratch dir for full-context exports, following the
 *  ~/.pi/extensions-data/<author>/<extension>/ convention (see pi-token-cost-ledger).
 *  Derived from getAgentDir() so rebranded distros resolve correctly. */
function askContextDir(): string {
	return path.join(path.dirname(getAgentDir()), "extensions-data", "estebanforge", "pi-antigravity-bridge");
}

interface AgyDetails {
	model: string | null;
	resolvedModel: string | null;
	thinking: ThinkingTier | null;
	mode: AgyMode;
	digest: boolean;
	conversationId: string | null;
	includeContext: boolean;
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	// Exit 0 with no answer on stdout (the empty-output failure branch).
	// renderResult flips to the error glyph on it.
	empty?: boolean;
	durationMs: number;
	stderr: string;
}

function emptyDetails(
	model: string | null = null,
	resolvedModel: string | null = null,
	thinking: ThinkingTier | null = null,
	includeContext: boolean = false,
): AgyDetails {
	return {
		model,
		resolvedModel,
		thinking,
		mode: "accept-edits",
		digest: false,
		includeContext,
		conversationId: null,
		exitCode: 0,
		aborted: false,
		timedOut: false,
		durationMs: 0,
		stderr: "",
	};
}
