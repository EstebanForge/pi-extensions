// Framed settings/picker menu: RTK optimizer's modal contract (SettingItem
// rows, tabs, type-to-search, Enter/Space cycle, live onChange + updateValue
// sync) rendered with the pi-subagent-manager dialog pattern (framed rows,
// help panel). Subagent-manager portions MIT, Copyright (c) 2026 pi-subagent
// contributors.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi, type SettingItem } from "@earendil-works/pi-tui";
import { DIALOG_OPTIONS, dialogHeight, dialogText, frameDialog, type DialogHost } from "./frame.js";

/** A menu row is a pi-tui SettingItem; `onEdit` additionally opens a custom
 *  editor (input dialog, submenu) on Enter and keeps the menu open. Rows with
 *  `values` cycle in place on Enter/Space; rows with neither resolve the menu
 *  with their id. */
export interface DialogRow extends SettingItem {
	onEdit?: () => void;
}

export interface DialogTab {
	label: string;
	rows: DialogRow[];
}

export interface DialogMenuOptions {
	title: string;
	/** Muted line under the tab bar / counter (e.g. the settings file path). */
	subtitle?: string;
	/** Flat rows; ignored when `tabs` is provided. */
	rows?: DialogRow[];
	/** Row groups; left/right switch the active tab. */
	tabs?: DialogTab[];
	selectedId?: string;
	/** Footer hint; a string array picks the first variant that fits the width. */
	footer?: string | readonly string[];
	/** Type-to-filter within the active tab. Default on. */
	search?: boolean;
	/** Called after an in-place cycle commits a new value. */
	onChange?: (id: string, value: string) => void;
}

const DEFAULT_FOOTER = "↑↓ navigate · Enter select · Esc close";

export class DialogMenu {
	private selected = 0;
	private viewport = 1;
	private query = "";
	private activeTab = 0;

	constructor(
		private host: DialogHost,
		private theme: Theme,
		readonly options: DialogMenuOptions,
		private done: (selectedId: string | undefined) => void,
	) {}

	private get tabs(): DialogTab[] {
		return this.options.tabs ?? (this.options.rows ? [{ label: "", rows: this.options.rows }] : []);
	}

	private get rows(): DialogRow[] {
		const tab = this.tabs[this.activeTab];
		return tab ? tab.rows : [];
	}

	private get filtered(): DialogRow[] {
		const rows = this.rows;
		const q = this.query.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter((row) =>
			`${row.label} ${row.currentValue} ${row.id}`.toLowerCase().includes(q),
		);
	}

	getSelectedId(): string | undefined {
		return this.filtered[this.selected]?.id;
	}

	/** External value sync: patch one row's displayed value by id, all tabs. */
	updateValue(id: string, value: string): void {
		for (const tab of this.tabs) {
			const row = tab.rows.find((r) => r.id === id);
			if (row) row.currentValue = value;
		}
	}

	private clampSelection(): void {
		const count = this.filtered.length;
		this.selected = Math.max(0, Math.min(count - 1, this.selected));
	}

	private move(offset: number): void {
		this.clampSelection();
		const count = this.filtered.length;
		this.selected = Math.max(0, Math.min(count - 1, this.selected + offset));
		this.host.requestRender();
	}

	private cycle(): void {
		const row = this.filtered[this.selected];
		if (!row?.values?.length) return;
		const current = row.currentValue;
		const at = row.values.indexOf(current);
		const next = row.values[(at + 1) % row.values.length] ?? row.values[0] ?? current;
		row.currentValue = next;
		this.options.onChange?.(row.id, next);
		this.host.requestRender();
	}

	private switchTab(direction: number): void {
		if (this.tabs.length < 2) return;
		const count = this.tabs.length;
		this.activeTab = ((this.activeTab + direction) % count + count) % count;
		this.query = "";
		this.selected = 0;
		this.host.requestRender();
	}

	private activate(): void {
		const row = this.filtered[this.selected];
		if (!row) return this.done(undefined);
		if (row.values?.length) return this.cycle();
		if (row.onEdit) {
			row.onEdit();
			return;
		}
		this.done(this.getSelectedId());
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) {
			if (this.query) {
				this.query = "";
				this.clampSelection();
				this.host.requestRender();
				return;
			}
			return this.done(undefined);
		}
		if (this.query && matchesKey(data, Key.backspace)) {
			this.query = this.query.slice(0, -1);
			this.clampSelection();
			this.host.requestRender();
			return;
		}
		if (keys.matches(data, "tui.select.confirm") || (!this.query && data === " ")) {
			return this.activate();
		}
		if (matchesKey(data, "left")) return this.switchTab(-1);
		if (matchesKey(data, "right")) return this.switchTab(1);
		let offset = 0;
		if (keys.matches(data, "tui.select.up")) offset = -1;
		else if (keys.matches(data, "tui.select.down") || matchesKey(data, Key.tab)) offset = 1;
		else if (matchesKey(data, Key.pageUp)) offset = -this.viewport;
		else if (matchesKey(data, Key.pageDown)) offset = this.viewport;
		else if (matchesKey(data, Key.home)) offset = -this.filtered.length;
		else if (matchesKey(data, Key.end)) offset = this.filtered.length;
		if (offset !== 0) return this.move(offset);
		if (this.options.search !== false && data.length === 1 && data >= " ") {
			this.query += data;
			this.clampSelection();
			this.host.requestRender();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const height = dialogHeight(this.host);
		const inner = Math.max(0, width - 4);
		const rows = this.filtered;
		this.clampSelection();

		const tabCount = this.tabs.length;
		const body: string[] = [];
		if (tabCount > 1) body.push(this.renderTabBar(width));
		body.push(
			this.theme.fg(
				"dim",
				` ${rows.length ? this.selected + 1 : 0}/${rows.length} · Field / Value${this.query ? ` · /${this.query}` : ""}`,
			),
		);
		if (this.options.subtitle) {
			body.push(this.theme.fg("muted", ` ${truncateToWidth(dialogText(this.options.subtitle), Math.max(1, inner), "…")}`));
		}

		const helpLines = wrapHelp(this.theme, rows[this.selected]?.description ?? "", inner, height);
		const reserved = helpLines.length + (this.options.subtitle ? 1 : 0) + (tabCount > 1 ? 1 : 0);
		this.viewport = Math.max(1, height - 6 - reserved);
		const start = Math.max(0, Math.min(this.selected - this.viewport + 1, rows.length - this.viewport));

		const hasValueColumn = rows.some((row) => row.currentValue !== undefined);
		const labelWidth = Math.min(
			28,
			Math.max(8, Math.floor(inner * 0.35)),
			hasValueColumn ? Math.max(0, inner - 2 - 3 - 1) : Infinity,
		);
		for (let i = start; i < Math.min(rows.length, start + this.viewport); i++) {
			body.push(this.renderRow(rows[i]!, start + i === this.selected, labelWidth));
		}
		body.push("");
		body.push(...helpLines);

		return frameDialog(
			this.theme,
			width,
			height,
			this.options.title + (this.query ? ` · /${this.query}` : ""),
			body,
			this.options.footer ?? DEFAULT_FOOTER,
		);
	}

	private renderRow(row: DialogRow, isSelected: boolean, labelWidth: number): string {
		const color = (text: string) => (isSelected ? this.theme.fg("accent", text) : text);
		const label = truncateToWidth(dialogText(row.label), labelWidth, "", true);
		const padding = " ".repeat(Math.max(0, labelWidth - visibleWidth(label)));
		return (
			color(`${isSelected ? "›" : " "} `) +
			color(label) +
			color(`${padding} │ `) +
			color(dialogText(row.currentValue))
		);
	}

	private renderTabBar(width: number): string {
		const parts = this.tabs.map((tab, i) =>
			i === this.activeTab
				? this.theme.fg("accent", `[ ${tab.label} ]`)
				: this.theme.fg("muted", `  ${tab.label}  `),
		);
		return truncateToWidth(parts.join(""), Math.max(1, width), "…");
	}
}

function wrapHelp(theme: Theme, help: string, inner: number, height: number): string[] {
	if (!help) return [];
	return wrapTextWithAnsi(dialogText(help), Math.max(1, inner - 1))
		.slice(0, Math.max(1, height - 8))
		.map((line) => theme.fg("muted", ` ${line}`));
}

/** Run one framed menu overlay. Resolves with the accepted row id, or
 *  undefined when closed. */
export function dialogMenu(
	ctx: DialogContext,
	title: string,
	rows: DialogRow[],
	options: Partial<Pick<DialogMenuOptions, "subtitle" | "tabs" | "selectedId" | "footer" | "search" | "onChange">> = {},
): Promise<string | undefined> {
	return ctx.ui.custom(
		(host, theme, _keys, done) =>
			new DialogMenu(host, theme, { title, rows, ...options }, done),
		DIALOG_OPTIONS,
	);
}

/** Structural subset of an extension context: what dialogs actually touch. */
export interface DialogContext {
	hasUI: boolean;
	mode?: string;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		custom<T>(factory: CustomFactory<T>, options?: unknown): Promise<T>;
	};
}

type CustomFactory<T> = (
	host: DialogHost & Record<string, unknown>,
	theme: Theme,
	keys: unknown,
	done: (value: T) => void,
) => { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void };

/** Headless guard: dialogs need the interactive TUI. */
export function canOpenDialog(ctx: DialogContext): boolean {
	if (!ctx.hasUI) return false;
	if (ctx.mode && ctx.mode !== "tui") {
		ctx.ui.notify("Dialogs require interactive TUI mode.", "warning");
		return false;
	}
	return true;
}
