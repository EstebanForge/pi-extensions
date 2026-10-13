// Framed TUI dialog kit for @estebanforge Pi extensions. Dialog pattern
// adapted from pi-subagent-manager (MIT); see LICENSE for attribution.
export {
	DIALOG_OPTIONS,
	dialogHeight,
	dialogText,
	frameDialog,
	type DialogHost,
	type FrameTheme,
} from "./frame.js";
export {
	canOpenDialog,
	dialogMenu,
	DialogMenu,
	type DialogContext,
	type DialogRow,
	type DialogTab,
} from "./menu.js";
export { dialogInput, InputView, type DialogInputOptions } from "./input.js";
export {
	assertChoiceOptions,
	ChoiceView,
	dialogChoice,
	MAX_CHOICE_OPTIONS,
	type ChoiceDialogOptions,
	type ChoiceOption,
} from "./choice.js";
