// Component-level tests for the dialog kit: frame geometry, footer variants,
// menu navigation, RTK-parity cycling (Enter/Space, live onChange), search
// filtering, tab switching, and input validation. Hosts are plain objects;
// rendering goes through the real pi-tui paths.
import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { dialogHeight, dialogText, frameDialog } from "../src/frame.js";
import { DialogMenu, type DialogRow } from "../src/menu.js";

const host = () => ({ requestRender() {}, terminal: { rows: 24 } });

// Bypass pi's real theme: tests assert structure, not color codes.
const theme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

const plain = (lines: string[]) => lines.join("\n");
// pi-tui 1.2 moved its cursor/fake-cursor markers to APC sequences
// (ESC _ pi:c BEL etc.); strip those alongside CSI or text reads split.
const stripAnsi = (text: string) =>
	text
		.replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, "")
		.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

describe("frame", () => {
	it("pads the body to a stable height and clips overflow", () => {
		const lines = frameDialog(theme, 30, 10, "Title", ["a", "b", "c", "d", "e", "f", "g"], "footer");
		expect(lines).toHaveLength(10);
		expect(lines[0]).toMatch(/^╭ Title /);
		expect(lines[7]).toMatch(/^├─+┤$/);
		expect(lines[8]).toContain("footer");
		expect(lines[9]).toMatch(/^╰─+╯$/);
		expect(plain(lines)).toContain("│a ");
		expect(plain(lines)).not.toContain("│g");
	});

	it("picks the first footer variant that fits, else the last", () => {
		const footer = ["very long hint that will never fit here at all", "short hint"];
		// 20 wide: inner 18, footer budget 15 -> short variant fits.
		const wide = frameDialog(theme, 20, 8, "t", ["x"], footer)[6]!;
		expect(wide).toContain("short hint");
		expect(wide).not.toContain("very long");
		// 8 wide: no variant fits the 3-char budget -> last variant wins, clipped.
		expect(frameDialog(theme, 8, 8, "t", ["x"], ["medium fallback", "tiny"])[6]).toContain("tiny");
	});

	it("degrades to a bare title line below minimum size", () => {
		const lines = frameDialog(theme, 3, 3, "Title", ["x"], "f");
		expect(stripAnsi(lines[0]!)).toBe("Tit");
		expect(frameDialog(theme, 0, 0, "T", [], "f")).toEqual([]);
	});

	it("dialogHeight follows the pi overlay formula", () => {
		expect(dialogHeight({ terminal: { rows: 24 } })).toBe(21);
		expect(dialogHeight({})).toBe(21);
		expect(dialogHeight({ terminal: { rows: 4 } })).toBe(2);
	});
});

describe("DialogMenu", () => {
	const rows: DialogRow[] = [
		{ id: "a", label: "Alpha", currentValue: "on", values: ["on", "off"], description: "Alpha help" },
		{ id: "b", label: "Beta", currentValue: "100", description: "Beta help" },
		{ id: "c", label: "Gamma", currentValue: "", description: "Gamma help" },
	];

	it("enter and space cycle values rows in place and report the change", () => {
		const changes: Array<[string, string]> = [];
		const menu = new DialogMenu(host(), theme, { title: "t", rows, onChange: (id, v) => changes.push([id, v]) }, () => {});
		menu.handleInput("\r");
		expect(changes).toEqual([["a", "off"]]);
		menu.handleInput(" ");
		expect(changes).toEqual([["a", "off"], ["a", "on"]]);
		expect(rows[0]!.currentValue).toBe("on");
	});

	it("enter on an onEdit row runs the action and keeps the menu open", () => {
		let edited = 0;
		let closed: string | undefined | "open" = "open";
		const menu = new DialogMenu(
			host(),
			theme,
			{ title: "t", rows: [{ id: "e", label: "Edit", currentValue: "", onEdit: () => { edited++; } }] },
			(id) => { closed = id; },
		);
		menu.handleInput("\r");
		expect(edited).toBe(1);
		expect(closed).toBe("open");
	});

	it("enter on a plain row resolves with its id; esc resolves undefined", () => {
		let picked: string | undefined | "open" = "open";
		const menu = new DialogMenu(host(), theme, { title: "t", rows: [{ id: "only", label: "Only", currentValue: "x" }] }, (id) => { picked = id; });
		menu.handleInput("\r");
		expect(picked).toBe("only");

		let closed: string | undefined | "open" = "open";
		const menu2 = new DialogMenu(host(), theme, { title: "t", rows }, (id) => { closed = id; });
		menu2.handleInput("\x1b");
		expect(closed).toBeUndefined();
	});

	it("navigates with arrows, tab, home, and end", () => {
		const menu = new DialogMenu(host(), theme, { title: "t", rows }, () => {});
		expect(menu.getSelectedId()).toBe("a");
		menu.handleInput("\x1b[B"); // down
		expect(menu.getSelectedId()).toBe("b");
		menu.handleInput("\t"); // tab = down
		expect(menu.getSelectedId()).toBe("c");
		menu.handleInput("\x1b[H"); // home
		expect(menu.getSelectedId()).toBe("a");
		menu.handleInput("\x1b[F"); // end
		expect(menu.getSelectedId()).toBe("c");
		menu.handleInput("\x1b[A"); // up
		expect(menu.getSelectedId()).toBe("b");
	});

	it("search filters rows; esc clears the query before closing", () => {
		let closed: string | undefined | "open" = "open";
		const menu = new DialogMenu(host(), theme, { title: "t", rows }, (id) => { closed = id; });
		menu.handleInput("g");
		menu.handleInput("a");
		expect(menu.getSelectedId()).toBe("c"); // "ga" matches Gamma
		menu.handleInput("\x1b"); // clears query, stays open
		expect(closed).toBe("open");
		expect(stripAnsi(plain(menu.render(60)))).not.toContain("/ga");
		menu.handleInput("\x1b"); // closes
		expect(closed).toBeUndefined();
	});

	it("search matches values too and survives no-match without crashing", () => {
		const menu = new DialogMenu(host(), theme, { title: "t", rows }, () => {});
		menu.handleInput("1");
		menu.handleInput("0");
		menu.handleInput("0");
		expect(menu.getSelectedId()).toBe("b");
		menu.handleInput("z");
		expect(menu.getSelectedId()).toBeUndefined();
		expect(stripAnsi(plain(menu.render(60)))).toContain("0/0");
	});

	it("switches tabs on kitty-protocol encoded arrows; ignores modified arrows", () => {
		// Regression from the rtk modal: pi-tui enables the kitty keyboard
		// protocol, which re-encodes bare arrows as \x1b[1;1D / \x1b[1;1C.
		// Tab switching must honor both encodings and no others.
		const menu = new DialogMenu(
			host(),
			theme,
			{ title: "t", tabs: [{ label: "A", rows: [{ id: "a", label: "A", currentValue: "" }] }, { label: "B", rows: [{ id: "b", label: "B", currentValue: "" }] }] },
			() => {},
		);
		menu.handleInput("\x1b[1;1C"); // ctrl-free kitty right
		expect(menu.getSelectedId()).toBe("b");
		menu.handleInput("\x1b[1;1D"); // kitty left
		expect(menu.getSelectedId()).toBe("a");
		menu.handleInput("\x1b[1;5C"); // ctrl+right: must not switch
		expect(menu.getSelectedId()).toBe("a");
	});

	it("left/right switch tabs and reset query and selection", () => {
		const changes: Array<[string, string]> = [];
		const menu = new DialogMenu(
			host(),
			theme,
			{
				title: "t",
				tabs: [
					{ label: "General", rows: [{ id: "g1", label: "G one", currentValue: "on", values: ["on", "off"] }] },
					{ label: "Limits", rows: [{ id: "l1", label: "L one", currentValue: "5", values: ["5", "10"] }] },
				],
				onChange: (id, v) => changes.push([id, v]),
			},
			() => {},
		);
		menu.handleInput("g"); // filter active tab
		menu.handleInput("\x1b[D"); // left: new tab, query cleared
		expect(menu.getSelectedId()).toBe("l1");
		menu.handleInput("\r");
		expect(changes).toEqual([["l1", "10"]]);
		menu.handleInput("\x1b[C"); // right: wraps to first tab
		expect(menu.getSelectedId()).toBe("g1");
	});

	it("renders selected cursor, tab bar, subtitle, counter, and help", () => {
		const menu = new DialogMenu(
			host(),
			theme,
			{
				title: "Settings",
				subtitle: "file: .pi/x.json",
				tabs: [{ label: "General", rows }, { label: "Other", rows: [{ id: "o", label: "O", currentValue: "" }] }],
			},
			() => {},
		);
		const text = stripAnsi(plain(menu.render(80)));
		expect(text).toContain("╭ Settings ");
		expect(text).toContain("[ General ]");
		expect(text).toContain("1/3 · Field / Value");
		expect(text).toContain("file: .pi/x.json");
		expect(text).toContain("›");
		expect(text).toContain("Alpha help");
		expect(text).toContain("↑↓ navigate");
	});

	it("updateValue syncs a row across tabs without input", () => {
		const menu = new DialogMenu(host(), theme, { title: "t", rows }, () => {});
		menu.updateValue("a", "off");
		expect(stripAnsi(plain(menu.render(60)))).toContain("off");
		expect(menu.getSelectedId()).toBe("a");
	});

	it("scrolls long lists instead of rendering past the frame", () => {
		const many: DialogRow[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, label: `Row ${i}`, currentValue: "" }));
		const menu = new DialogMenu(host(), theme, { title: "t", rows: many }, () => {});
		for (let i = 0; i < 39; i++) menu.handleInput("\x1b[B");
		const text = plain(menu.render(60));
		expect(text).toContain("Row 39");
		expect(text).not.toContain("Row 0\n");
	});
});

describe("dialogText", () => {
	it("strips ANSI and replaces control characters with spaces", () => {
		expect(dialogText("\x1b[31mred\x1b[0m\x07!")).toBe("red !");
	});
});
