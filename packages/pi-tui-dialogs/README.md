# @estebanforge/pi-tui-dialogs

Framed TUI dialog kit for `@estebanforge` Pi Coding Agent extensions. One
settings/picker pattern for every extension instead of one per package.

Dialog pattern adapted from
[pi-subagent-manager](https://github.com/championswimmer/pi-subagent-manager)
(MIT); tabs and type-to-search follow the Zellij modal they replace.

## What it ships

- `frameDialog` / `dialogHeight` / `DIALOG_OPTIONS` — shared rounded frame:
  title in the top border, body, footer line above the bottom border, padded to
  a stable height so centered overlays do not jump between views.
- `DialogMenu` / `dialogMenu` — framed menu with `label │ value` rows, a
  counter line, a muted help panel for the selected row, optional tab groups
  (left/right to switch) and type-to-search within the active tab. Rows with
  `values` cycle in place on Enter; rows with `onEdit` run a custom action and
  keep the menu open; plain rows resolve the menu with their id.
- `dialogInput` — framed single-line input with placeholder, help lines, and
  optional `validate`: return an error string to keep the dialog open with the
  message inline, return `undefined` to accept.
- `dialogChoice` — framed single-choice modal: one decision statement (wraps),
  a closed option list of 1 to `MAX_CHOICE_OPTIONS` (10) options with unique
  values and an optional preselect. Enter resolves the chosen option's value;
  esc resolves `undefined` (the escape hatch). Caller-contract violations (0
  or >10 options, duplicate values, unknown preselect) throw before any
  overlay opens.
- `canOpenDialog` — headless guard for non-TUI modes.

## Usage

```ts
import { canOpenDialog, dialogChoice, dialogInput, dialogMenu, DialogMenu } from "@estebanforge/pi-tui-dialogs";

await ctx.ui.custom(
	(host, theme, _keys, done) =>
		new DialogMenu(
			host,
			theme,
			{
				title: "My extension",
				subtitle: "Project file: .pi/my-extension.json",
				tabs: [
					{ label: "General", rows: [{ id: "enabled", label: "Enabled", value: "on", values: ["on", "off"], help: "Master switch." }] },
					{ label: "Limits", rows: [{ id: "cap", label: "Cap", value: "100", onEdit: () => void dialogInput(ctx, "Cap", { initial: "100", validate: (raw) => (/^\d+$/.test(raw) ? undefined : "must be a number") }) }] },
				],
				onChange: (id, value) => save(id, value),
			},
			() => done(),
		),
	// DIALOG_OPTIONS centers the dialog near fullscreen
);
```

A closed choice reads the same way:

```ts
const engine = await dialogChoice(ctx, "Choose your engine", {
	description: "Which engine runs your turns? Switch anytime with /engine.",
	options: [
		{ value: "fast", label: "Fast", description: "default · lighter" },
		{ value: "deep", label: "Deep", description: "downloads a big binary" },
	],
	selected: "fast",
});
// engine === undefined means esc: decide later, persist nothing.
```

Plain library, no Pi entrypoint: depend on it and Pi installs it transitively.

## License

MIT. See LICENSE for the pi-subagent-manager attribution.
