// Settings editor for /unblock settings: the @estebanforge/pi-tui-dialogs
// framed menu (RTK modal contract) over the project settings file. Row
// construction, value parsing, and the headless snapshot are pure and
// unit-tested; this module also owns the overlay + input-dialog glue.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { DIALOG_OPTIONS, DialogMenu, InputView, type DialogRow } from "@estebanforge/pi-tui-dialogs";
import { SETTING_LIMITS, type Reviewer, type UnblockSettings } from "./settings.js";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const REVIEWERS: readonly Reviewer[] = ["claude", "codex", "agy"];

const ok = (value: unknown): ParseResult<unknown> => ({ ok: true, value });
const err = (error: string): ParseResult<unknown> => ({ ok: false, error });

function parseNumberIn(raw: string, min: number, max: number): ParseResult<unknown> {
	const n = Number(raw);
	if (!raw || !Number.isFinite(n)) return err(`"${raw}" is not a number`);
	if (n < min || n > max) return err(`must be ${min}..${max}`);
	return ok(n);
}

function parseCountIn(raw: string, min: number): ParseResult<unknown> {
	const n = Number(raw);
	if (!raw || !Number.isFinite(n)) return err(`"${raw}" is not a number`);
	if (!Number.isInteger(n)) return err(`"${raw}" is not an integer`);
	if (n < min) return err(`must be >= ${min}`);
	return ok(n);
}

/** Narrow one raw editor/cycle value to its typed settings entry. Same clamps
 *  the defensive loader applies, so a saved value never loads back
 *  differently than it was typed. Unknown ids fail closed. */
export function parseSettingValue<K extends keyof UnblockSettings>(
	id: K,
	raw: string,
): ParseResult<UnblockSettings[K]> {
	return parseRaw(id, raw) as ParseResult<UnblockSettings[K]>;
}

function parseRaw(id: string, raw: string): ParseResult<unknown> {
	const text = raw.trim();
	switch (id) {
		case "reviewer":
			return REVIEWERS.includes(text as Reviewer) ? ok(text) : err(`reviewer must be one of: ${REVIEWERS.join(", ")}`);
		case "binary":
		case "model":
		case "effort":
		case "claudeModel":
		case "claudeEffort":
		case "codexModel":
		case "codexEffort":
		case "agyModel":
		case "agyEffort":
			return ok(text || null);
		case "preprompt":
			return ok(text);
		case "threshold":
			return parseCountIn(text, SETTING_LIMITS.thresholdMin);
		case "cooldownSec":
			return parseNumberIn(text, SETTING_LIMITS.cooldownSecMin, Number.MAX_SAFE_INTEGER);
		case "timeoutSec":
			return parseNumberIn(text, SETTING_LIMITS.timeoutSecMin, SETTING_LIMITS.timeoutSecMax);
		case "maxAutoConsultsPerSession":
			return parseCountIn(text, SETTING_LIMITS.maxAutoConsultsMin);
		case "contextMaxTurns":
			return parseCountIn(text, SETTING_LIMITS.contextMaxTurnsMin);
		case "maxOutputCharsPerTurn":
			return parseNumberIn(text, SETTING_LIMITS.maxOutputCharsPerTurnMin, Number.MAX_SAFE_INTEGER);
		case "autoUnblockOnFailure":
		case "confirmOnPush":
			if (text === "on") return ok(true);
			if (text === "off") return ok(false);
			return err("must be on or off");
		case "ignoredCommands":
			return ok(text ? text.split(",").map((c) => c.trim()).filter(Boolean) : []);
		default:
			return err(`unknown setting: ${id}`);
	}
}

/** Rows built for the editor cycle: the overlay attaches a text-input editor
 *  to these on open (pure rows stay theme-free for tests). */
export const EDITOR_IDS: ReadonlySet<string> = new Set([
	"binary",
	"model",
	"effort",
	"claudeModel",
	"claudeEffort",
	"codexModel",
	"codexEffort",
	"agyModel",
	"agyEffort",
	"threshold",
	"cooldownSec",
	"timeoutSec",
	"maxAutoConsultsPerSession",
	"preprompt",
	"contextMaxTurns",
	"maxOutputCharsPerTurn",
	"ignoredCommands",
]);

const EDITOR_HINTS: Record<string, string> = {
	binary: "empty = stock reviewer CLI from PATH",
	model: "empty = the reviewer's own default",
	effort: "cli default | claude: default/low/medium/high/xhigh; codex: minimal..max; agy: low/medium/high",
	claudeModel: "empty = global model",
	claudeEffort: "default, low, medium, high, xhigh; empty = global effort",
	codexModel: "empty = global model",
	codexEffort: "minimal, low, medium, high, xhigh, max; empty = global effort",
	agyModel: "empty = global model",
	agyEffort: "low, medium, high; empty = global effort",
	threshold: `integer, >= ${SETTING_LIMITS.thresholdMin}`,
	cooldownSec: "seconds, >= 0",
	timeoutSec: `seconds, ${SETTING_LIMITS.timeoutSecMin}..${SETTING_LIMITS.timeoutSecMax}`,
	maxAutoConsultsPerSession: `integer, >= ${SETTING_LIMITS.maxAutoConsultsMin}`,
	preprompt: "sent ahead of every consult frame",
	contextMaxTurns: `integer, >= ${SETTING_LIMITS.contextMaxTurnsMin}`,
	maxOutputCharsPerTurn: `chars, >= ${SETTING_LIMITS.maxOutputCharsPerTurnMin}`,
	ignoredCommands: "comma-separated command roots",
};

/** The raw value an editor starts from — never the display placeholder. */
function rawEditorInitial(id: string, s: UnblockSettings): string {
	if (id === "ignoredCommands") return s.ignoredCommands.join(", ");
	const v = s[id as keyof UnblockSettings];
	return typeof v === "string" ? v : String(v ?? "");
}

export function buildSettingItems(s: UnblockSettings): SettingItem[] {
	return [
		{
			id: "reviewer",
			label: "Reviewer",
			description:
				"Peer that reviews on trigger: claude, codex, or agy. Consults run one-shot under read-only postures.",
			currentValue: s.reviewer,
			values: [...REVIEWERS],
		},
		{
			id: "binary",
			label: "Binary override",
			description:
				"Executable override for the reviewer CLI (wrapper or stub). Empty uses the stock CLI name resolved via PATH.",
			currentValue: s.binary ?? "(default: PATH)",
		},
		{
			id: "model",
			label: "Model",
			description: "Model passed to the reviewer CLI. Empty uses the reviewer's own default.",
			currentValue: s.model ?? "(reviewer default)",
		},
		{
			id: "effort",
			label: "Thinking effort",
			description:
				"Thinking effort passed to the reviewer CLI. Empty uses the CLI's own default; ladders differ per CLI.",
			currentValue: s.effort ?? "(cli default)",
		},
		{
			id: "claudeModel",
			label: "Claude model",
			description: "Model used when the reviewer is claude. Beats the global model; empty falls back to it.",
			currentValue: s.claudeModel ?? "(global model)",
		},
		{
			id: "claudeEffort",
			label: "Claude effort",
			description: "Thinking effort for claude. Beats the global effort; empty falls back to it.",
			currentValue: s.claudeEffort ?? "(global effort)",
		},
		{
			id: "codexModel",
			label: "Codex model",
			description: "Model used when the reviewer is codex. Beats the global model; empty falls back to it.",
			currentValue: s.codexModel ?? "(global model)",
		},
		{
			id: "codexEffort",
			label: "Codex effort",
			description: "Reasoning effort for codex. Beats the global effort; empty falls back to it.",
			currentValue: s.codexEffort ?? "(global effort)",
		},
		{
			id: "agyModel",
			label: "Agy model",
			description: "Model used when the reviewer is agy. Beats the global model; empty falls back to it.",
			currentValue: s.agyModel ?? "(global model)",
		},
		{
			id: "agyEffort",
			label: "Agy effort",
			description: "Thinking level for agy. Beats the global effort; empty falls back to it.",
			currentValue: s.agyEffort ?? "(global effort)",
		},
		{
			id: "threshold",
			label: "Failure threshold",
			description: `Consecutive same-root failures before an auto consult fires. Minimum ${SETTING_LIMITS.thresholdMin}.`,
			currentValue: String(s.threshold),
		},
		{
			id: "cooldownSec",
			label: "Cooldown (sec)",
			description: "Seconds after a consult before another auto consult may fire.",
			currentValue: String(s.cooldownSec),
		},
		{
			id: "timeoutSec",
			label: "Consult timeout (sec)",
			description: `Consult wall-clock budget. ${SETTING_LIMITS.timeoutSecMin}..${SETTING_LIMITS.timeoutSecMax}; a value that high would instant-kill the reviewer, so it is clamped.`,
			currentValue: String(s.timeoutSec),
		},
		{
			id: "maxAutoConsultsPerSession",
			label: "Max auto consults",
			description: "Automatic consults per session. After the cap, only /unblock and the publish gate consult.",
			currentValue: String(s.maxAutoConsultsPerSession),
		},
		{
			id: "preprompt",
			label: "Preprompt",
			description:
				"Always sent ahead of the consult frame — use it as the standing adversarial instruction (e.g. \"Attack the premise first\").",
			currentValue: s.preprompt || "(none)",
		},
		{
			id: "contextMaxTurns",
			label: "Context turns",
			description: "Recent turns fed to the reviewer as material.",
			currentValue: String(s.contextMaxTurns),
		},
		{
			id: "maxOutputCharsPerTurn",
			label: "Output cap per turn",
			description: "Per-turn tool-output tail kept for the reviewer, in characters.",
			currentValue: String(s.maxOutputCharsPerTurn),
		},
		{
			id: "autoUnblockOnFailure",
			label: "Auto consult on failure",
			description: "off: failure loops only notify — the reviewer is never invoked automatically.",
			currentValue: s.autoUnblockOnFailure ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "confirmOnPush",
			label: "Confirm publish",
			description: "off: git push / gh pr create run without the confirm-and-consult gate.",
			currentValue: s.confirmOnPush ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "ignoredCommands",
			label: "Ignored commands",
			description:
				"Command roots that never build a failure streak, merged with the built-in exploratory set (grep, rg, find, ls, ...).",
			currentValue: s.ignoredCommands.length > 0 ? s.ignoredCommands.join(", ") : "none",
		},
	];
}

/** Hosts the framed input editor inside the settings overlay (one overlay,
 *  swapped views) so focus never has to jump between stacked overlays. */
type EditorView = {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
};

/** Headless (rpc/json/print) snapshot: every knob and the file that backs it. */
export function settingsSnapshotText(s: UnblockSettings, filePath: string): string {
	return [
		"peer-review settings",
		`  reviewer:                  ${s.reviewer}`,
		`  binary:                    ${s.binary ?? "(default: PATH)"}`,
		`  model:                     ${s.model ?? "(reviewer default)"}`,
		`  effort:                    ${s.effort ?? "(cli default)"}`,
		`  claudeModel:               ${s.claudeModel ?? "(global model)"}`,
		`  claudeEffort:              ${s.claudeEffort ?? "(global effort)"}`,
		`  codexModel:                ${s.codexModel ?? "(global model)"}`,
		`  codexEffort:               ${s.codexEffort ?? "(global effort)"}`,
		`  agyModel:                  ${s.agyModel ?? "(global model)"}`,
		`  agyEffort:                 ${s.agyEffort ?? "(global effort)"}`,
		`  threshold:                 ${s.threshold}`,
		`  cooldownSec:               ${s.cooldownSec}`,
		`  timeoutSec:                ${s.timeoutSec}`,
		`  maxAutoConsultsPerSession: ${s.maxAutoConsultsPerSession}`,
		`  preprompt:                 ${s.preprompt || "(none)"}`,
		`  contextMaxTurns:           ${s.contextMaxTurns}`,
		`  maxOutputCharsPerTurn:     ${s.maxOutputCharsPerTurn}`,
		`  autoUnblockOnFailure:      ${s.autoUnblockOnFailure}`,
		`  confirmOnPush:             ${s.confirmOnPush}`,
		`  ignoredCommands:           ${s.ignoredCommands.length > 0 ? s.ignoredCommands.join(", ") : "(none)"}`,
		``,
		`Edit: ${filePath}`,
	].join("\n");
}

/** Run the settings dialog. Resolves with the typed patch to save, or null
 *  when the user closed without touching anything. Persisting + applying the
 *  patch to the live controller stays with the caller. */
export async function openUnblockSettings(
	ctx: ExtensionCommandContext,
	settings: UnblockSettings,
): Promise<Partial<UnblockSettings> | null> {
	const pending: Partial<UnblockSettings> = {};
	let touched = false;
	// Local draft: edits show immediately; the caller persists the patch.
	const draft: UnblockSettings = { ...settings };

	await ctx.ui.custom<void>(
		(host, theme, _keybindings, done) => {
			let editor: InputView | null = null;

			const applyValue = (id: string, value: unknown) => {
				(draft as unknown as Record<string, unknown>)[id] = value;
				(pending as Record<string, unknown>)[id] = value;
				touched = true;
				// Refresh every row's display from the draft (placeholders differ from raw values).
				for (const fresh of buildSettingItems(draft)) {
					menu.updateValue(fresh.id, fresh.currentValue);
				}
				host.requestRender();
			};

			const rows: DialogRow[] = buildSettingItems(draft).map((item) => {
				if (!EDITOR_IDS.has(item.id)) return item;
				return {
					...item,
					onEdit: () => {
						editor = new InputView(
							host,
							theme,
							item.label,
							{
								initial: rawEditorInitial(item.id, draft),
								help: EDITOR_HINTS[item.id] ?? "",
								placeholder: "empty = default",
								validate: (raw) => {
									const parsed = parseRaw(item.id, raw);
									return parsed.ok ? undefined : parsed.error;
								},
							},
							(value) => {
								editor = null;
								if (value !== undefined) {
									const parsed = parseRaw(item.id, value);
									if (parsed.ok) applyValue(item.id, parsed.value);
								}
								host.requestRender();
							},
						);
						host.requestRender();
					},
				};
			});

			const menu = new DialogMenu(
				host,
				theme,
				{
					title: "peer-review settings",
					subtitle: "Project file: .pi/unblock-settings.json — changes save when the dialog closes",
					rows,
					footer: "↑↓ navigate · Enter edit · Type to search · Esc close",
					onChange: (id, value) => {
						const parsed = parseRaw(id, value);
						if (parsed.ok) applyValue(id, parsed.value);
					},
				},
				() => done(),
			);

			const active = (): EditorView | DialogMenu => editor ?? menu;
			return {
				render: (width: number) => active().render(width),
				invalidate: () => active().invalidate(),
				handleInput: (data: string) => {
					active().handleInput(data);
					host.requestRender();
				},
			};
		},
		DIALOG_OPTIONS,
	);

	return touched ? pending : null;
}
