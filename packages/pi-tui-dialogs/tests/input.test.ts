// Input dialog validation contract: invalid input keeps the dialog open with
// the error rendered inline; valid input resolves; esc resolves undefined.
import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { dialogInput, type DialogContext } from "../src/index.js";

const theme = { fg: (_c: string, t: string) => t } as unknown as Theme;

type Captured = {
	host: { requestRender(): void; terminal: { rows: number } };
	done: (value: string | undefined) => void;
	view: { render(width: number): string[]; handleInput(data: string): void };
};

// pi-tui 1.2 moved its cursor/fake-cursor markers to APC sequences
// (ESC _ pi:c BEL etc.); strip those alongside CSI or text reads split.
const stripAnsi = (text: string) =>
	text
		.replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, "")
		.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

/** Stand-in for ctx.ui.custom: captures the factory result and its done callback. */
function captureCtx(): { ctx: DialogContext; captured: Captured[] } {
	const captured: Captured[] = [];
	const ctx: DialogContext = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify() {},
			custom<T>(factory: (host: never, theme: Theme, keys: never, done: (v: T) => void) => unknown): Promise<T> {
				return new Promise<T>((resolve) => {
					const done = (value: T) => resolve(value);
					const host = { requestRender() {}, terminal: { rows: 24 } };
					const view = factory(host as never, theme, undefined as never, done as never) as Captured["view"];
					captured.push({ host, done: done as (value: string | undefined) => void, view });
				});
			},
		},
	};
	return { ctx, captured };
}

describe("dialogInput", () => {
	it("prefills with the cursor at the end, accepts valid input", async () => {
		const { ctx, captured } = captureCtx();
		const promise = dialogInput(ctx, "Cap", { initial: "10", validate: (raw) => (/^\d+$/.test(raw) ? undefined : "not a number") });
		await Promise.resolve();
		const view = captured[0]!.view;
		// Prefilled value renders (cursor marker may split it; strip ANSI).
		expect(stripAnsi(view.render(60).join("\n"))).toContain("10");
		view.handleInput("\x7f"); // backspace -> "1"
		view.handleInput("2"); // -> "12"
		view.handleInput("\r");
		await expect(promise).resolves.toBe("12");
	});

	it("rejects invalid input inline and stays open, then accepts a fix", async () => {
		const { ctx, captured } = captureCtx();
		const promise = dialogInput(ctx, "Cap", { initial: "50", validate: (raw) => (/^\d+$/.test(raw) ? undefined : "must be a number") });
		await Promise.resolve();
		const view = captured[0]!.view;
		for (let i = 0; i < 2; i++) view.handleInput("\x7f"); // -> ""
		view.handleInput("abc"); // -> "abc"
		view.handleInput("\r");
		expect(stripAnsi(view.render(60).join("\n"))).toContain("must be a number");
		let resolved: string | undefined | "pending" = "pending";
		void promise.then((v) => { resolved = v; });
		await Promise.resolve();
		expect(resolved).toBe("pending");
		for (let i = 0; i < 3; i++) view.handleInput("\x7f"); // -> ""
		view.handleInput("7");
		view.handleInput("\r");
		await expect(promise).resolves.toBe("7");
	});

	it("esc cancels even with an invalid value", async () => {
		const { ctx, captured } = captureCtx();
		const promise = dialogInput(ctx, "Cap", { initial: "abc", validate: () => "no" });
		await Promise.resolve();
		captured[0]!.view.handleInput("\x1b");
		await expect(promise).resolves.toBeUndefined();
	});

	it("renders placeholder and help text", async () => {
		const { ctx, captured } = captureCtx();
		void dialogInput(ctx, "Cap", { placeholder: "empty = default", help: "Positive integer." });
		await Promise.resolve();
		const text = stripAnsi(captured[0]!.view.render(60).join("\n"));
		expect(text).toContain("empty = default");
		expect(text).toContain("Positive integer.");
		expect(text).toContain("Enter apply");
	});
});
