// Entry-wiring regression for Pi 1.2.0: runs started by
// pi.sendMessage({ triggerTurn: true }) (the ask-* wake path) now fire
// before_agent_start with a "custom" event that carries no user prompt.
// The handler must count those as turns without touching event.prompt;
// prompt capture stays user-run-only (review-engine.test.ts covers the
// engine side).
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../extensions/index.js";

const cwd = mkdtempSync(join(tmpdir(), "peer-review-entry-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function makeFakePi() {
	const handlers: Record<string, (event: never, ctx: never) => unknown> = {};
	const commands: Record<string, (args: string, cmdCtx: never) => unknown> = {};
	// Proxy so unimplemented API calls (registerTool, sendMessage, ...) no-op.
	const pi: any = new Proxy(
		{
			on: (event: string, handler: (event: never, ctx: never) => unknown) => {
				handlers[event] = handler;
			},
			registerCommand: (name: string, def: { handler: (args: string, cmdCtx: never) => unknown }) => {
				commands[name] = def.handler;
			},
		},
		{
			get(target, prop) {
				return prop in target ? (target as any)[prop] : () => {};
			},
		},
	);
	return { pi, handlers, commands };
}

const ctx = { cwd, ui: { notify: () => {} }, hasUI: false };

describe("before_agent_start with the Pi 1.2.0 event union", () => {
	it("wake run (custom event, no prompt) does not throw", async () => {
		const { pi, handlers, commands } = makeFakePi();
		await factory(pi);
		await handlers.session_start({} as never, ctx as never);
		expect(() =>
			handlers.before_agent_start(
				{
					type: "before_agent_start",
					messageType: "custom",
					systemPrompt: "",
					systemPromptOptions: { cwd },
					message: { customType: "pi-ask-shared/wake", content: "consult finished" },
				} as never,
				ctx as never,
			),
		).not.toThrow();
		// The wake run counts as a live turn: the /peer-review busy gate must
		// refuse while it runs (pins the unconditional agentBusy branch that
		// a no-op handler would otherwise pass).
		const notify = vi.fn();
		await commands["peer-review"]("", { ui: { notify }, signal: undefined } as never);
		expect(notify).toHaveBeenCalledWith(
			"peer-review: the agent is still working; call it again when it settles",
			"warning",
		);
	});

	it("user turn still records its prompt without throwing", async () => {
		const { pi, handlers } = makeFakePi();
		await factory(pi);
		await handlers.session_start({} as never, ctx as never);
		expect(() =>
			handlers.before_agent_start(
				{
					type: "before_agent_start",
					messageType: "user",
					systemPrompt: "",
					systemPromptOptions: { cwd },
					prompt: "fix the login bug",
				} as never,
				ctx as never,
			),
		).not.toThrow();
	});
});
