// Framed single-choice modal: one decision statement plus a closed list of
// options, esc cancels. SelectList inside the shared frame. Pattern extracted
// from pi-antigravity-bridge's first-run engine picker.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { DIALOG_OPTIONS, dialogHeight, dialogText, frameDialog, type DialogHost } from "./frame.js";
import type { DialogContext } from "./menu.js";

/** Hard cap on the option list. A closed choice stays scannable; past ten
 *  options the caller should filter or paginate before asking. */
export const MAX_CHOICE_OPTIONS = 10;

/** One closed choice. Values are the resolved contract: they must be unique
 *  and stable across releases (callers persist them). */
export interface ChoiceOption {
	value: string;
	label: string;
	/** One-line hint under the label; the list truncates long lines. */
	description?: string;
}

export interface ChoiceDialogOptions {
	/** Options in answer order; the first is preselected unless `selected`. */
	options: ChoiceOption[];
	/** What the user is deciding; wraps to the frame width. */
	description?: string;
	/** Preselected option value; must match one option. */
	selected?: string;
	/** Footer hint; default "↑↓ navigate · enter select · esc cancel". */
	footer?: string | readonly string[];
}

/** Caller-contract validation. Throws before any overlay opens: a choice
 *  modal rendered with 0 options, duplicate values, or a bogus preselect is
 *  a programming error, not a user-facing state. Used directly by ChoiceView
 *  (sync throw) and by dialogChoice (which rejects). */
export function assertChoiceOptions(options: ChoiceOption[], selected?: string): void {
	if (options.length < 1) {
		throw new RangeError(`dialogChoice needs at least 1 option, got ${options.length}`);
	}
	if (options.length > MAX_CHOICE_OPTIONS) {
		throw new RangeError(`dialogChoice takes at most ${MAX_CHOICE_OPTIONS} options, got ${options.length}`);
	}
	const seen = new Set<string>();
	for (const option of options) {
		if (seen.has(option.value)) {
			throw new RangeError(`dialogChoice options have duplicate value "${option.value}"`);
		}
		seen.add(option.value);
	}
	if (selected !== undefined && !seen.has(selected)) {
		throw new RangeError(`dialogChoice selected "${selected}" matches no option`);
	}
}

/** Hostable framed choice component. `done` resolves the decision: the
 *  chosen value, or undefined on esc. Render it inside your own overlay and
 *  route input to it while it is active. */
export class ChoiceView {
	private readonly list: SelectList;
	private settled = false;

	constructor(
		private host: DialogHost,
		private theme: Theme,
		readonly title: string,
		readonly options: ChoiceDialogOptions,
		private readonly done: (value: string | undefined) => void,
	) {
		assertChoiceOptions(options.options, options.selected);
		const items: SelectItem[] = options.options.map((option) => ({
			value: option.value,
			label: dialogText(option.label),
			description: option.description === undefined ? undefined : dialogText(option.description),
		}));
		this.list = new SelectList(items, items.length, {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});
		if (options.selected !== undefined) {
			this.list.setSelectedIndex(items.findIndex((item) => item.value === options.selected));
		}
		this.list.onSelect = (item) => this.finish(item.value);
		this.list.onCancel = () => this.finish(undefined);
	}

	private finish(value: string | undefined): void {
		if (this.settled) return;
		this.settled = true;
		this.done(value);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
		this.host.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const height = dialogHeight(this.host);
		const descriptionLines = this.options.description
			? wrapTextWithAnsi(dialogText(this.options.description), inner).map((line) =>
					this.theme.fg("muted", ` ${line}`),
				)
			: [];
		// Window the list to what the frame can actually show (DialogMenu's
		// viewport rule). frameDialog clips the body to height - 4; without
		// this the SelectList would render all options and let the selection
		// move into clipped, invisible lines on short terminals or with long
		// descriptions. The - 3 covers the two blank separators plus the
		// "(n/m)" scroll line SelectList appends whenever the list is windowed
		// (clipping that line hides the position hint). maxVisible is
		// compile-time private on SelectList but a plain field at runtime;
		// re-assigning it per render is the intended windowing knob (the
		// constructor value only sized the initial view).
		const listBudget = Math.max(1, height - 4 - descriptionLines.length - 3);
		(this.list as unknown as { maxVisible: number }).maxVisible = listBudget;
		return frameDialog(
			this.theme,
			width,
			dialogHeight(this.host),
			this.title,
			[
				"",
				...descriptionLines,
				"",
				...this.list.render(inner).map((line) => ` ${line}`),
			],
			this.options.footer ?? "↑↓ navigate · enter select · esc cancel",
		);
	}
}

/** Run one framed choice overlay. Resolves with the chosen option value, or
 *  undefined when cancelled (esc). Contract violations reject the promise
 *  before the overlay opens. */
export async function dialogChoice(
	ctx: DialogContext,
	title: string,
	options: ChoiceDialogOptions,
): Promise<string | undefined> {
	// Fail before the overlay opens so a bad caller contract cannot flash UI.
	assertChoiceOptions(options.options, options.selected);
	return ctx.ui.custom<string | undefined>(
		(host, theme, _keys, done) => new ChoiceView(host, theme, title, options, done),
		DIALOG_OPTIONS,
	);
}
