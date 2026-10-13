// Choice dialog contract: one decision, a closed option list (1..10),
// enter resolves the picked value, esc resolves undefined (the escape
// hatch). Count/duplicate/unknown-preselect caller errors throw at
// construction, before any overlay opens.
import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	ChoiceView,
	dialogChoice,
	MAX_CHOICE_OPTIONS,
	type ChoiceOption,
	type DialogContext,
} from "../src/index.js";

const theme = { fg: (_c: string, t: string) => t } as unknown as Theme;

const opts: ChoiceOption[] = [
	{ value: "a", label: "Alpha", description: "first choice" },
	{ value: "b", label: "Beta", description: "second choice" },
];

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

describe("dialogChoice", () => {
	it("enter resolves the preselected (first) option's value", async () => {
		const { ctx, captured } = captureCtx();
		const promise = dialogChoice(ctx, "Pick one", { options: opts });
		await Promise.resolve();
		captured[0]!.view.handleInput("\r");
		await expect(promise).resolves.toBe("a");
	});

	it("esc resolves undefined and stays settled", async () => {
		const { ctx, captured } = captureCtx();
		const promise = dialogChoice(ctx, "Pick one", { options: opts });
		await Promise.resolve();
		captured[0]!.view.handleInput("\x1b");
		captured[0]!.view.handleInput("\r"); // late input after settle must not throw or re-resolve
		await expect(promise).resolves.toBeUndefined();
	});

	it("arrow down moves the selection; enter resolves the new value", async () => {
		const { ctx, captured } = captureCtx();
		const promise = dialogChoice(ctx, "Pick one", { options: opts });
		await Promise.resolve();
		captured[0]!.view.handleInput("\x1b[B");
		captured[0]!.view.handleInput("\r");
		await expect(promise).resolves.toBe("b");
	});

	it("selected preselects the requested option", async () => {
		const { ctx, captured } = captureCtx();
		const promise = dialogChoice(ctx, "Pick one", { options: opts, selected: "b" });
		await Promise.resolve();
		captured[0]!.view.handleInput("\r");
		await expect(promise).resolves.toBe("b");
	});

	it("renders the title, wrapped description, and footer", async () => {
		const { ctx, captured } = captureCtx();
		void dialogChoice(ctx, "Pick one", {
			options: opts,
			description: "Decide which engine runs your turns. This is a long line that must wrap to the frame width instead of being truncated away.",
		});
		await Promise.resolve();
		const text = stripAnsi(captured[0]!.view.render(60).join("\n"));
		expect(text).toContain("Pick one");
		expect(text).toContain("Decide which engine");
		expect(text).toContain("truncated away");
		expect(text).toContain("enter select");
		expect(text).toContain("esc cancel");
	});

	it("rejects the promise on an invalid contract instead of throwing sync", async () => {
		const { ctx } = captureCtx();
		await expect(dialogChoice(ctx, "Pick one", { options: [] })).rejects.toThrow(RangeError);
	});

	it("windows the list on short terminals so the selection never leaves the frame", async () => {
		// rows=12 -> dialogHeight 10 -> frame budget 6 lines; ""+1 desc line+"")
		// overhead leaves 3 list rows. All 10 options must stay navigable
		// (SelectList scrolls its window) and the frame must stay 10 lines.
		const captured: Captured[] = [];
		const ctx: DialogContext = {
			hasUI: true,
			mode: "tui",
			ui: {
				notify() {},
				custom<T>(factory: (host: never, theme: Theme, keys: never, done: (v: T) => void) => unknown): Promise<T> {
					return new Promise<T>((resolve) => {
						const done = (value: T) => resolve(value);
						const host = { requestRender() {}, terminal: { rows: 12 } };
						const view = factory(host as never, theme, undefined as never, done as never) as Captured["view"];
						captured.push({ host, done: done as (value: string | undefined) => void, view });
					});
				},
			},
		};
		const ten = Array.from({ length: MAX_CHOICE_OPTIONS }, (_, i) => ({
			value: `v${i}`,
			label: `Option ${i}`,
			description: `hint ${i}`,
		}));
		const promise = dialogChoice(ctx, "Pick one", { options: ten, description: "Pick one of ten." });
		await Promise.resolve();
		const view = captured[0]!.view;
		const first = stripAnsi(view.render(60).join("\n"));
		expect(first).toContain("Option 0");
		expect(first).not.toContain("Option 9");
		for (let i = 0; i < 4; i++) view.handleInput("\x1b[B");
		const moved = stripAnsi(view.render(60).join("\n"));
		expect(moved).toContain("Option 4");
		// SelectList appends an "(n/m)" scroll line when windowed; the budget
		// must leave room for it inside the frame instead of clipping it.
		expect(moved).toContain("(5/10)");
		expect(moved.split("\n")).toHaveLength(10); // frame stays the dialog height
		view.handleInput("\r");
		await expect(promise).resolves.toBe("v4");
	});
});

describe("ChoiceView validation", () => {
	const host = () => ({ requestRender() {}, terminal: { rows: 24 } });
	const build = (options: ChoiceOption[], selected?: string) =>
		new ChoiceView(host(), theme, "t", { options, selected }, () => {});

	it("allows 1 option and MAX (10) options", () => {
		expect(MAX_CHOICE_OPTIONS).toBe(10);
		expect(() => build([{ value: "only", label: "Only" }])).not.toThrow();
		const ten = Array.from({ length: MAX_CHOICE_OPTIONS }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
		expect(() => build(ten)).not.toThrow();
	});

	it("throws on 0 options and on more than MAX options", () => {
		expect(() => build([])).toThrow(RangeError);
		const eleven = Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
		expect(() => build(eleven)).toThrow(RangeError);
	});

	it("throws on duplicate values and on an unknown selected value", () => {
		expect(() => build([{ value: "x", label: "1" }, { value: "x", label: "2" }])).toThrow(RangeError);
		expect(() => build(opts, "nope")).toThrow(RangeError);
	});

	it("renders a one-option list and ten-option list", () => {
		const one = build([{ value: "only", label: "Only" }]);
		expect(stripAnsi(one.render(60).join("\n"))).toContain("Only");
		const ten = Array.from({ length: MAX_CHOICE_OPTIONS }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
		const tenView = build(ten);
		expect(stripAnsi(tenView.render(60).join("\n"))).toContain("Option 9");
	});
});
