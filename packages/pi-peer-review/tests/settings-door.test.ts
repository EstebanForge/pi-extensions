import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import register from "../extensions/index.js";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function harness() {
	const commands = new Map<string, Handler>();
	const events = new Map<string, Array<(...a: unknown[]) => unknown>>();
	const pi = {
		on: (ev: string, fn: (...a: unknown[]) => unknown) => {
			const list = events.get(ev) ?? [];
			list.push(fn);
			events.set(ev, list);
		},
		registerCommand: (name: string, def: { handler: Handler }) => commands.set(name, def.handler),
		sendMessage: vi.fn(async () => {}),
	} as unknown as ExtensionAPI;
	register(pi);
	return { commands, events };
}

describe("settings door dispatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const [args, label] of [
		["settings", "settings token"],
		["config", "config alias"],
	] as const) {
		it(`${label} opens the settings dialog, not a review`, async () => {
			const cwd = mkdtempSync(join(tmpdir(), "pr-door-"));
			const { commands, events } = harness();

			const state: { customCalled?: boolean; buildError?: string; renderHead?: string[] } = {};
			const notifies: Array<{ text: string; level?: string }> = [];
			const ui = {
				notify: (text: string, level?: string) => notifies.push({ text, level }),
				confirm: vi.fn(async () => true),
				custom: vi.fn(async (builder: any) => {
					state.customCalled = true;
					try {
						const view = builder(
							{ requestRender() {}, terminal: { rows: 40 } },
							{ fg: (_c: string, t: string) => t },
							{},
							() => {},
						);
						state.renderHead = view.render(80).slice(0, 3);
					} catch (err) {
						state.buildError = err instanceof Error ? err.stack : String(err);
					}
				}),
			};
			const ctx = { mode: "tui", cwd, hasUI: true, ui, signal: new AbortController().signal } as unknown as ExtensionCommandContext;

			await Promise.all((events.get("session_start") ?? []).map((h) => h({}, ctx)));

			const handler = commands.get("peer-review");
			expect(handler, "/peer-review registered").toBeTruthy();
			await handler!(args, ctx);

			expect(state.customCalled, "ctx.ui.custom (the dialog door) was invoked").toBe(true);
			expect(state.buildError, `dialog built cleanly${state.buildError ? `: ${state.buildError.split("\n").slice(0, 6).join("\n")}` : ""}`).toBeUndefined();
			expect(state.renderHead?.join("\n")).toMatch(/peer-review settings/);
			expect(notifies, "no toast substitutes for the window").toEqual([]);
		});
	}
});
