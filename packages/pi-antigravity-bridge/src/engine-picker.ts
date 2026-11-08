// First-run onboarding: the engine picker plus the agy-presence warning.
//
// On the first interactive start (no config file yet, no AGY_ENGINE env) pi
// asks which native agy engine to use: stream-json or `agy acp`. The choice persists via saveConfig({ engine }) and,
// like /agy engine, takes effect on the next pi start (drivers wire at load).
// Startup checks the CLI once per process and offers setup when needed.
//
// UI: the shared framed choice modal from @estebanforge/pi-tui-dialogs
// (dialogChoice): one decision statement, a closed option list, esc cancels.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { dialogChoice, type ChoiceOption, type DialogContext, type DialogRow } from "@estebanforge/pi-tui-dialogs";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ENGINE, type Engine } from "./config.js";

/** Picker order is the default answer order: acp (the default engine)
 *  preselected first, stream-json as the fallback. */
export const ENGINE_PICKER_ITEMS: ChoiceOption[] = [
	{
		value: "acp",
		label: "ACP (agy acp)",
		description: "default · ACP server in the agy CLI",
	},
	{
		value: "stream-json",
		label: "Stream-JSON CLI",
		description: "the `agy` CLI, fallback",
	},
];

/** Intro paragraph above the list. Text wraps, so explanations stay here and
 *  option descriptions stay one-liners (the choice list truncates long lines). */
export const ENGINE_PICKER_INTRO = [
	"Pick the engine that runs your Antigravity turns. Switch anytime with /agy engine (restart applies it).",
	"",
	"ACP (default): `agy acp`, the ACP server built into the agy CLI. Uses the same installation and Google sign-in as the CLI.",
	"stream-json (fallback): the `agy` CLI you already installed and authenticated. Persistent process, streamed output.",
].join("\n");

/** True only for a genuine first interactive run: no saved config yet (any
 *  existing file means the user has been here before) and no AGY_ENGINE env
 *  (env wins over the file, so the wizard would fight it). Fails closed to
 *  false - an fs error must never nag the user with a dialog. */
export function shouldOfferEnginePicker(
	configPath: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (env.AGY_ENGINE !== undefined) return false;
	try {
		return !fs.existsSync(configPath);
	} catch {
		return false;
	}
}

/** Narrow a picker value to an Engine. Items are our own constants, but an
 *  unknown value must never reach config as a cast string: it falls back to
 *  the default engine (acp), same rule as loadConfig's narrowing. */
export function toEngine(value: string): Engine {
	return value === "acp" || value === "stream-json" ? value : DEFAULT_ENGINE;
}

/** Toast copy shown after the choice is saved. */
export function savedEngineMessage(engine: Engine): string {
	return engine === "acp"
		? "Engine saved: acp. Turns will use `agy acp` and your existing CLI authentication. Restart applies the engine."
		: "Engine saved: stream-json. Restart pi to apply.";
}

/** /agy settings row that opens the engine picker. Deliberately value-less:
 *  DialogMenu cycles rows that carry `values`, but resolves the menu with the
 *  row id on Enter for rows without — the caller then closes settings and
 *  opens the same modal as the first-run wizard. The active engine rides as
 *  the display value so the row reads like the rest of the surface. */
export const ENGINE_SETTINGS_ROW_ID = "engine";

export function engineSettingsRow(engine: Engine): DialogRow {
	return {
		id: ENGINE_SETTINGS_ROW_ID,
		label: "Switch engine",
		description:
			"Open the engine picker (stream-json CLI vs agy acp). Enter opens it and closes settings; esc in the picker changes nothing. Restart applies a switch.",
		currentValue: engine,
	};
}

/** True when the `agy` CLI binary can be found. A binRef with a path
 *  separator (AGY_BIN=/opt/agy/agy) must exist as a file; a bare name is
 *  searched on PATH. statSync cannot throw through the guards, but a race
 *  (file removed between listing and stat) fails closed to false. */
export function isAgyInstalled(binRef: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (binRef.includes("/")) {
		try {
			return fs.statSync(binRef).isFile();
		} catch {
			return false;
		}
	}
	return (env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.some((dir) => {
			try {
				return fs.statSync(path.join(dir, binRef)).isFile();
			} catch {
				return false;
			}
		});
}

/** Toast copy for the missing-CLI warning. Fires every pi start while the
 *  stream-json engine is active and the binary is absent. */
export function agyMissingMessage(): string {
	return "The `agy` CLI is not installed. Install it from https://antigravity.google/product/antigravity-cli and log in on it to use Antigravity models.";
}

/** The kit's DialogContext wants the whole extension context, but both picker
 *  call sites hold only the ui object and are TUI-gated (ctx.mode === "tui")
 *  before they run. Wrap instead of threading two different ctx shapes. The
 *  cast is the pi-custom-options vs unknown-options signature gap; custom and
 *  notify exist at runtime on ExtensionUIContext. */
function asDialogContext(ui: ExtensionUIContext): DialogContext {
	return { hasUI: true, mode: "tui", ui: ui as unknown as DialogContext["ui"] };
}

/** Render the choice modal via the shared dialog kit. Resolves with the
 *  chosen engine, or undefined when the user pressed esc (decide later -
 *  nothing is persisted). */
export async function showEnginePicker(ctx: ExtensionUIContext): Promise<Engine | undefined> {
	const picked = await dialogChoice(asDialogContext(ctx), "Antigravity Bridge: choose your engine", {
		description: ENGINE_PICKER_INTRO,
		options: ENGINE_PICKER_ITEMS,
		footer: "↑↓ navigate · enter select · esc decide later",
	});
	return picked === undefined ? undefined : toEngine(picked);
}
