// Framed single-line input with optional inline validation. Hostable view for
// composing inside an existing overlay (settings menu editor slot) plus a
// ctx-level dialogInput wrapper. Pattern adapted from pi-subagent-manager
// (MIT, Copyright (c) 2026 pi-subagent contributors).
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { DIALOG_OPTIONS, dialogHeight, dialogText, frameDialog, type DialogHost } from "./frame.js";
import type { DialogContext } from "./menu.js";

export interface DialogInputOptions {
	/** Starting value (cursor lands at its end). */
	initial?: string;
	/** Muted help lines under the field. */
	help?: string;
	/** Placeholder while the field is empty. */
	placeholder?: string;
	/** Return an error string to keep the editor open with the message inline;
	 *  return undefined to accept. */
	validate?: (raw: string) => string | undefined;
}

/** Hostable framed input component. `done` resolves the editing session:
 *  accepted string, or undefined on esc. Render it inside your own overlay
 *  and route input to it while it is active. */
export class InputView {
	private readonly input: Input;
	private errorText = "";
	private settled = false;

	constructor(
		private host: DialogHost,
		private theme: Theme,
		readonly title: string,
		readonly options: DialogInputOptions,
		private readonly done: (value: string | undefined) => void,
	) {
		this.input = new Input(options.placeholder ? { placeholder: options.placeholder } : undefined);
		this.input.setValue(dialogText(options.initial ?? ""));
		// pi-tui Input starts the cursor at column 0; place it at the end of the
		// prefilled value (ctrl+e is the cursor-end binding) so editing behaves
		// the way the prefilled field looks.
		this.input.handleInput("\x05");
		this.input.focused = true;
		this.input.onSubmit = (value) => {
			const message = this.options.validate?.(value);
			if (message) {
				this.errorText = message;
				this.host.requestRender();
				return;
			}
			this.finish(value);
		};
		this.input.onEscape = () => this.finish(undefined);
	}

	private finish(value: string | undefined): void {
		if (this.settled) return;
		this.settled = true;
		this.done(value);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
		this.host.requestRender();
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const helpLines = this.options.help
			? wrapTextWithAnsi(dialogText(this.options.help), Math.max(1, width - 5))
				.map((line) => this.theme.fg("muted", ` ${line}`))
			: [];
		const errorLines = this.errorText
			? [this.theme.fg("error", ` ${dialogText(this.errorText)}`)]
			: [];
		return frameDialog(
			this.theme,
			width,
			dialogHeight(this.host),
			this.title,
			[
				"",
				...this.input.render(Math.max(1, width - 4)).map((line) => ` ${line}`),
				...errorLines,
				"",
				...helpLines,
			],
			"Enter apply · Esc cancel",
		);
	}
}

/** Run one framed input overlay. Resolves with the accepted value, or
 *  undefined when cancelled. */
export function dialogInput(
	ctx: DialogContext,
	title: string,
	options: DialogInputOptions = {},
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>(
		(host, theme, _keys, done) => new InputView(host, theme, title, options, done),
		DIALOG_OPTIONS,
	);
}
