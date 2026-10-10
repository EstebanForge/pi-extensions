// pi-unblock entrypoint: adapts pi's extension events onto the controller.
// No model-facing tool — the failure gate is deterministic and the model
// cannot talk itself out of it. See src/policy.ts for the semantics and
// src/controller.ts for the flow.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runConsult } from "@estebanforge/pi-ask-shared";
import { UnblockController } from "../src/controller.js";
import { loadUnblockSettings } from "../src/settings.js";

export default function unblockExtension(pi: ExtensionAPI): void {
	let controller: UnblockController | null = null;

	pi.on("session_start", async (_event, ctx) => {
		controller = new UnblockController(loadUnblockSettings(ctx.cwd), {
			notify: (text) => ctx.ui.notify(text, "warning"),
			inject: (text) => {
				void pi.sendMessage(
					{ customType: "pi-unblock/notice", content: text, display: true },
					{ deliverAs: "nextTurn" },
				);
			},
			runConsult,
			nowMs: () => Date.now(),
			// Headless JSON/print modes have no dialogs: absent confirm makes
			// the publish gate degrade to skip-and-log instead of blocking.
			confirm: ctx.hasUI ? (title, message) => ctx.ui.confirm(title, message) : undefined,
		});
	});

	// One agent run == one turn for streak decay and staleness stamping.
	pi.on("before_agent_start", () => {
		controller?.onTurnStart();
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

	pi.registerCommand("unblock", {
		description: "Consult the peer reviewer on demand (focus text optional)",
		handler: async (args, ctx) => {
			if (!controller) return;
			await controller.manualConsult(args.trim() || undefined, ctx.signal);
		},
	});
}
