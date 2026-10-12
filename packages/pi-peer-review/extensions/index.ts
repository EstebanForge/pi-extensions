// pi-peer-review entrypoint: adapts pi's extension events onto the controller.
// No model-facing tool — the failure gate is deterministic and the model
// cannot talk itself out of it. See src/policy.ts for the semantics and
// src/controller.ts for the flow.
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runConsult } from "@estebanforge/pi-ask-shared";
import { UnblockController } from "../src/controller.js";
import { loadUnblockSettings, saveUnblockSettings, type Reviewer, type UnblockSettings } from "../src/settings.js";
import { openUnblockSettings, settingsSnapshotText } from "../src/settings-ui.js";
import { ReviewEngine } from "../src/review-engine.js";

export default function unblockExtension(pi: ExtensionAPI): void {
	let controller: UnblockController | null = null;
	let reviewEngine: ReviewEngine | null = null;
	/** Idle gate for /peer-review: slash commands typed mid-run are refused. */
	let agentBusy = false;

	pi.on("session_start", async (_event, ctx) => {
		controller = new UnblockController(loadUnblockSettings(ctx.cwd), {
			notify: (text, level) => ctx.ui.notify(text, level ?? "warning"),
			inject: (text) => {
				void pi.sendMessage(
					{ customType: "pi-peer-review/notice", content: text, display: true },
					// steer, not nextTurn: nextTurn queues for the user's NEXT
					// prompt (drained alongside the next user message), which a
					// stuck mid-run loop would never see. steer delivers into the
					// live run.
					{ deliverAs: "steer" },
				);
			},
			runConsult,
			nowMs: () => Date.now(),
			// Headless JSON/print modes have no dialogs: absent confirm makes
			// the publish gate degrade to skip-and-log instead of blocking.
			confirm: ctx.hasUI ? (title, message) => ctx.ui.confirm(title, message) : undefined,
			reviewMaterial: (signal) => reviewEngine?.publishFrame(signal) ?? Promise.resolve(null),
			reviewStatusLine: () => reviewEngine?.unreviewedLine() ?? Promise.resolve(null),
			reviewSettled: () => reviewEngine?.markReviewed(),
		});
		reviewEngine = new ReviewEngine({
			cwd: ctx.cwd,
			getSettings: () => controller!.settings,
			ports: {
				runConsult,
				nowMs: () => Date.now(),
				notify: (text, level) => ctx.ui.notify(text, level ?? "warning"),
				injectNextTurn: (text) => {
					void pi.sendMessage(
						{ customType: "pi-peer-review/review", content: text, display: true },
						// nextTurn, not steer: reviews land when the agent is
						// idle; the findings ride along with the user's next prompt.
						{ deliverAs: "nextTurn" },
					);
				},
				tryStart: () => controller!.tryGate(),
				end: () => controller!.endGate(),
			},
		});
		void reviewEngine.baseline();
	});

	// One agent run == one turn for streak decay and staleness stamping. The
	// prompt is review material ("task since the pointer").
	pi.on("before_agent_start", (event) => {
		controller?.onTurnStart();
		reviewEngine?.notePrompt(event.prompt);
		agentBusy = true;
	});

	// Run ended: capture the executor's final message as the claim to verify.
	pi.on("agent_end", (event) => {
		agentBusy = false;
		reviewEngine?.noteClaim(assistantText(event.messages));
	});

	// Fully settled (no queued continuation): true idle + telemetry point.
	pi.on("agent_settled", (event) => {
		agentBusy = false;
		// pi 1.0.x types omit `aborted`; it exists from 1.1.0 on.
		const aborted = (event as { aborted?: boolean }).aborted ?? false;
		reviewEngine?.noteSettled(aborted);
	});

	// Observe every tool result; shell commands carry their command line. The
	// context signal aborts a detached consult when the turn ends (an aborted
	// consult was stale anyway).
	pi.on("tool_result", (event, ctx) => {
		if (!controller) return;
		const command =
			typeof event.input.command === "string" && event.input.command.trim()
				? event.input.command
				: undefined;
		const output = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		controller.onToolResult(event.toolName, !event.isError, command, output, ctx.signal);
		// Review-engine material: touch tracking, edit hunks, verify facts.
		if (event.toolName === "bash" || event.toolName === "powershell") {
			if (command) reviewEngine?.noteShell(command, !event.isError);
		} else if (event.toolName === "write" && !event.isError) {
			const input = event.input as { path?: unknown };
			if (typeof input.path === "string") reviewEngine?.noteWrite(input.path, "write");
		} else if (event.toolName === "edit" && !event.isError) {
			const input = event.input as { path?: unknown; edits?: { oldText?: unknown; newText?: unknown }[] };
			if (typeof input.path === "string" && Array.isArray(input.edits)) {
				const before = input.edits
					.map((e) => (typeof e.oldText === "string" ? e.oldText : ""))
					.join("\n");
				const after = input.edits
					.map((e) => (typeof e.newText === "string" ? e.newText : ""))
					.join("\n");
				reviewEngine?.noteEdit(input.path, before, after);
			}
		}
	});

	// Publish boundary: blockable pre-execution hook. The controller returns
	// { block: true, reason } when the user declines or when the pre-publish
	// review lands (the reason carries the verdict; the model re-issues the
	// command to consume the one-shot bypass).
	pi.on("tool_call", async (event, ctx) => {
		if (!controller) return undefined;
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const command =
			typeof event.input.command === "string" && event.input.command.trim()
				? event.input.command
				: "";
		if (!command) return undefined;
		return controller.onBeforePublish(command, ctx.signal);
	});

	// Command surface (three names, one handler):
	//   /peer-review [reviewer|full|focus]  -> diff review since the last check
	//   /unblock / /advice [focus]          -> stuck consult (ring material)
	//   ... settings                        -> settings editor (from any door)
	//   ... stuck [focus] / review [focus]  -> force the other door explicitly
	const REVIEWERS: ReadonlySet<string> = new Set(["claude", "codex", "agy"]);
	const handle = (defaultMode: "review" | "stuck") => async (args: string, ctx: ExtensionCommandContext) => {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		if (tokens[0] === "settings") {
			await openSettings(ctx);
			return;
		}
		let mode = defaultMode;
		if (tokens[0] === "stuck") {
			mode = "stuck";
			tokens.shift();
		} else if (tokens[0] === "review") {
			mode = "review";
			tokens.shift();
		}
		let reviewer: Reviewer | undefined;
		let full = false;
		if (mode === "review") {
			if (tokens[0] === "full") {
				full = true;
				tokens.shift();
			}
			if (tokens[0] !== undefined && REVIEWERS.has(tokens[0])) reviewer = tokens.shift() as Reviewer;
		}
		const focus = tokens.join(" ").trim() || undefined;
		if (!controller || !reviewEngine) return;
		if (mode === "review") {
			if (agentBusy) {
				ctx.ui.notify("peer-review: the agent is still working; call it again when it settles", "warning");
				return;
			}
			await reviewEngine.peerReview({ reviewer, full, focus, signal: ctx.signal });
		} else {
			await controller.manualConsult(focus, ctx.signal);
		}
	};

	pi.registerCommand("peer-review", {
		description: "Adversarial peer review of the changes since the last check (claude|codex|agy|full|focus)",
		handler: handle("review"),
	});
	pi.registerCommand("unblock", {
		description: "Consult the peer reviewer when stuck (focus text optional); alias of /advice",
		handler: handle("stuck"),
	});
	pi.registerCommand("advice", {
		description: "Consult the peer reviewer when stuck (focus text optional); alias of /unblock",
		handler: handle("stuck"),
	});

	async function openSettings(ctx: ExtensionCommandContext): Promise<void> {
		if (!controller) return;
		const settingsPath = join(ctx.cwd, ".pi", "unblock-settings.json");
		if (ctx.mode !== "tui") {
			ctx.ui.notify(settingsSnapshotText(controller.settings, settingsPath), "info");
			return;
		}
		const pending = await openUnblockSettings(ctx, controller.settings);
		if (!pending) return;
		try {
			const savedPath = saveUnblockSettings(ctx.cwd, pending);
			// Merge into the live controller: triggers read settings per event,
			// so the next consult already runs on the new values (no restart).
			controller.settings = { ...controller.settings, ...pending };
			ctx.ui.notify(`Saved: ${describePatch(pending)} (to ${savedPath})`, "info");
		} catch (err) {
			ctx.ui.notify(
				`Failed to save settings: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	}
}

function describePatch(patch: Partial<UnblockSettings>): string {
	return Object.entries(patch)
		.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
		.join(", ");
}

/** Last assistant message text from an agent_end payload (defensive: the
 *  message content may be a string or a block list). */
function assistantText(messages: readonly unknown[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown } | undefined;
		if (m?.role !== "assistant") continue;
		if (typeof m.content === "string" && m.content.trim()) return m.content;
		if (Array.isArray(m.content)) {
			const text = m.content
				.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
				.map((c) => c.text)
				.join("\n");
			if (text.trim()) return text;
		}
	}
	return null;
}
