/**
 * pi-mixture-of-agents — extension entry.
 *
 * Registers:
 *   - the virtual `moa` provider (presets selectable as `moa/<preset>` in /model)
 *   - the `/moa` one-shot command
 *
 * Provider models are derived from moa.json presets. When a preset is the
 * active model, Pi calls the streamSimple facade, which fans out the preset's
 * references, appends their outputs at the tail of the last user message,
 * and calls the aggregator (the acting model) with the full tool schema.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { TurnCache } from "../lib/dedup";
import { loadConfig, resolvePreset, formatPresetList, upsertPreset, removePreset, renamePreset, saveConfig, normalizePreset, userConfigPath } from "../lib/config";
import { runPresetTurn } from "../lib/engine";
import { makeCallSlot } from "../lib/slots";
import { trimForReferences } from "../lib/transcript";
import type { AdvisoryMessage } from "../lib/transcript";
import type { NormalizedConfig } from "../lib/types";
import { makeMoaStreamFacade, type CtxRef } from "../lib/stream-facade";

const PROVIDER_NAME = "moa";

// Status bar glyph prefixed to every setStatus payload. ⛙ (White Left Lane
// Merge) reads as N streams converging into one — the references fanning
// out and the aggregator merging them back. Mirrors the icon-before-text
// pattern pi-agentmemory uses for its status row. Defined once so every
// call site — the provider's onProgress and the /moa command's wrapper —
// stays in sync.
const STATUS_ICON = "⛙";
const formatStatus = (text: string | undefined): string | undefined =>
	text === undefined ? undefined : `${STATUS_ICON} ${text}`;

export default async function (pi: ExtensionAPI) {
	// Mutable holder for the live ExtensionContext. streamSimple has no ctx
	// in its signature, so the facade reads through this ref.
	const ctxRef: CtxRef = { current: null };
	const configState: { current: NormalizedConfig | null } = { current: null };
	const cache = new TurnCache();

	async function refreshConfig(): Promise<NormalizedConfig> {
		const cfg = await loadConfig();
		configState.current = cfg;
		return cfg;
	}

	// Register the virtual provider in the factory body so it is flushed
	// before the model catalog is built (and before session_start). The docs
	// are explicit: provider registrations queued in an async factory are
	// awaited; those queued in event handlers are not.
	const initialCfg = await refreshConfig();
	registerMoaProvider(pi, initialCfg, { ctxRef, cache, getConfig: () => configState.current ?? initialCfg });

	pi.on("session_start", async (_event, ctx) => {
		ctxRef.current = ctx;
		// Re-read on each session in case the user edited moa.json. Wrap so a
		// malformed file (e.g. a recursive `moa:` slot) surfaces as a notify
		// instead of an unhandled rejection that leaves the config stale.
		try {
			await refreshConfig();
		} catch (e) {
			ctx.ui.notify(`MoA: failed to load config — ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	});

	// Drop the stale ctx between sessions so a mid-/reload invocation cannot
	// accidentally use a torn-down ExtensionContext.
	pi.on("session_shutdown", () => {
		ctxRef.current = null;
	});

	// New user turn boundary: clear the per-turn reference cache so refs run
	// fresh for the next turn. (Within a turn, tool-loop iterations reuse it.)
	pi.on("model_select", () => cache.clear());

	// Single `/moa` command. Binary routing: no argument opens the
	// settings screen (TUI) or read-only list (headless); ANY argument is a
	// one-shot MoA pass. No reserved words, so `/moa explain X` and
	// `/moa delete my branch` both run as one-shots. Management (new, edit,
	// delete, enable, default) lives as rows inside the screen.
	pi.registerCommand("moa", {
		description: "MoA: open settings (no arg), or run a one-shot pass over <prompt>.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "") {
				await runMoaScreen(ctx);
				return;
			}
			await runMoaCommand(trimmed, ctx, pi);
		},
	});

	function registerMoaProvider(
		pi: ExtensionAPI,
		cfg: NormalizedConfig,
		deps: { ctxRef: CtxRef; cache: TurnCache; getConfig: () => NormalizedConfig },
	) {
		const presetNames = Object.keys(cfg.presets);
		// Unregister first so stale model rows from a prior session can't survive:
		// pi-ai's registry appends on re-registration, so a renamed/deleted preset
		// (e.g. moa/glm-5.2 → moa/SOTA Exp) would otherwise leave a dangling row
		// that can win first-turn dispatch and surface as "unknown MoA preset".
		//_unregisterProvider(PROVIDER_NAME) is a no-op if nothing is registered.
		pi.unregisterProvider(PROVIDER_NAME);
		if (presetNames.length === 0) return;

		const onProgress = (text: string | undefined) => {
			const ctxNow = ctxRef.current as ExtensionContext | null;
			if (ctxNow && "ui" in ctxNow) {
				(ctxNow as unknown as { ui: { setStatus: (k: string, t: string | undefined) => void } })
					.ui.setStatus(PROVIDER_NAME, formatStatus(text));
			}
		};

		const streamSimple = makeMoaStreamFacade({
			getConfig: deps.getConfig,
			ctxRef: deps.ctxRef,
			cache: deps.cache,
			onProgress,
		});

		pi.registerProvider(PROVIDER_NAME, {
			name: "Mixture of Agents",
			// api must be a UNIQUE identifier ("moa"), NOT a real api like
			// "openai-completions". pi-coding-agent bridges registerProvider into
			// pi-ai's global apiProviderRegistry keyed by `api`; registering under
			// "openai-completions" clobbers the builtin and hijacks every
			// OpenAI-compatible model (e.g. zai) into moaStream, surfacing as
			// "unknown MoA preset: <model-id>". Our own moa/<preset> models inherit
			// this api so they dispatch back here to streamSimple. baseUrl/apiKey
			// are required placeholders so the models surface in the picker.
			api: PROVIDER_NAME,
			baseUrl: "https://moa.local/v1",
			apiKey: "moa-virtual-provider",
			models: presetNames.map((name) => ({
				id: name,
				name: `MoA: ${name}`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: cfg.presets[name].max_tokens,
			})),
			streamSimple,
		});
	}
}

// Row id prefixes for the screen. Each preset gets four rows
// (`enabled`, `default`, `edit`, `delete`); plus a global `new` row. The
/**
 * `/moa` with no argument. Drill-down menu (same SettingsList component as
 * `/settings`), three levels via the native `submenu` field:
 *
 *   Top     →  Browse presets…   New preset…
 *   Browse  →  one row per preset (or an empty-state note when none exist)
 *   Preset  →  aggregator / references (read-only), enabled, default,
 *              Edit refs/aggregator…, Delete…
 *
 * Enabled/default flip in-memory and persist on close with one reload. Edit,
 * delete, and new can't live inside SettingsList (they need modal
 * select/input/confirm dialogs that steal focus), so they stage an action, break
 * out of the menu, and run after it closes. Outside the TUI, falls back to the
 * read-only listing.
 */
async function runMoaScreen(ctx: ExtensionCommandContext): Promise<void> {
	const raw = await loadConfigRaw();
	// Narrow once: presets is optional in MoaConfig, but the whole menu assumes
	// an object. Local const lets us index without `!` at every call site.
	const presets = raw.presets ?? {};
	const names = Object.keys(presets);

	if (!ctx.hasUI || ctx.mode !== "tui") {
		const cfg = await loadConfig();
		ctx.ui.notify(formatPresetList(cfg), "info");
		return;
	}

	// In-memory working copy for the enabled/default toggles. Materialized to
	// disk only on close so a single reload covers every flip in the visit.
	const enabled: Record<string, boolean> = {};
	for (const n of names) enabled[n] = presets[n].enabled ?? true;
	const working = {
		defaultPreset: raw.default_preset ?? names[0] ?? "",
		enabled,
	};
	// Modal actions stage here and run after the custom() dialog closes. Holder
	// object dodges the TS closure-narrowing trap (a bare `let` reassigned inside
	// the custom() callback collapses to `never` after the await).
	const pending: {
		value:
			| { kind: "new" }
			| { kind: "edit"; name: string }
			| { kind: "delete"; name: string }
			| { kind: "rename"; name: string }
			| null;
	} = { value: null };

	await ctx.ui.custom((tui, theme, _kb, done) => {
		// Break out of the whole menu and run `action` once the dialog closes.
		const exit = (
			action:
				| { kind: "new" }
				| { kind: "edit"; name: string }
				| { kind: "delete"; name: string }
				| { kind: "rename"; name: string },
		) => {
			pending.value = action;
			done(undefined);
		};

		// Wrap a SettingsList with a title heading; forward input to the list so
		// arrow keys / Esc work inside submenus.
		const wrap = (title: string, list: SettingsList): Component => {
			const c = new Container();
			c.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 1));
			c.addChild(list);
			return {
				render: (w: number) => c.render(w),
				invalidate: () => c.invalidate(),
				handleInput: (data: string) => {
					list.handleInput?.(data);
				},
			};
		};

		// Level 3: a single preset's detail / edit view.
		const buildDetail = (name: string, back: () => void): Component => {
			const p = presets[name];
			const refLabel =
				Array.isArray(p.reference_models) && p.reference_models.length > 0
					? p.reference_models.map((s) => `${s.provider}/${s.model}`).join(", ")
					: "(none — aggregator alone)";
			const items: SettingItem[] = [
				{
					id: "name",
					label: "Name",
					description: "Rename this preset.",
					currentValue: name,
					values: [name],
				},
				{
					id: "agg",
					label: "Aggregator",
					description: "Synthesizes the references and produces the final reply.",
					currentValue: `${p.aggregator.provider}/${p.aggregator.model}`,
				},
				{
					id: "refs",
					label: "References",
					description: "Parallel second opinions fed to the aggregator.",
					currentValue: refLabel,
				},
				{
					id: "enabled",
					label: "Enabled",
					description: "On: references fan out then aggregate. Off: aggregator alone.",
					currentValue: working.enabled[name] ? "on" : "off",
					values: ["on", "off"],
				},
				{
					id: "default",
					label: "Default",
					description: "Preset used when you pick `moa/` without naming one.",
					currentValue: working.defaultPreset === name ? "yes" : "no",
					values: ["yes", "no"],
				},
				{
					id: "edit",
					label: "Edit refs / aggregator…",
					description: "Re-pick the aggregator and reference models.",
					currentValue: "open",
					values: ["open"],
				},
				{
					id: "delete",
					label: "Delete preset…",
					description: "Remove this preset (confirms next).",
					currentValue: "remove",
					values: ["remove"],
				},
			];
			const list = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === "name") {
						exit({ kind: "rename", name });
						return;
					}
					if (id === "edit") {
						exit({ kind: "edit", name });
						return;
					}
					if (id === "delete") {
						exit({ kind: "delete", name });
						return;
					}
					if (id === "enabled") {
						working.enabled[name] = newValue === "on";
						return;
					}
					if (id === "default") {
						// Radio-like: "yes" promotes this preset. "no" on the current
						// default is a no-op (there must always be a default).
						if (newValue === "yes") working.defaultPreset = name;
						list.updateValue("default", working.defaultPreset === name ? "yes" : "no");
					}
				},
				back,
			);
			return wrap(name, list);
		};

		// Level 2: the preset list, or an empty-state note when none exist.
		const buildList = (back: () => void): Component => {
			let items: SettingItem[];
			if (names.length === 0) {
				items = [
					{
						id: "empty",
						label: "No presets configured yet",
						description: "Esc to go back, then pick 'New preset…'.",
						currentValue: "",
					},
				];
			} else {
				items = names.map((name) => ({
					id: name,
					label: name,
					description: `${presets[name].aggregator.provider}/${presets[name].aggregator.model}`,
					currentValue: name === working.defaultPreset ? "default" : "",
					submenu: (_cv, subDone) => buildDetail(name, subDone),
				}));
			}
			const list = new SettingsList(items, Math.min(items.length + 2, 15), getSettingsListTheme(), () => {}, back);
			return wrap("Presets", list);
		};

		// Level 1: top menu.
		const topItems: SettingItem[] = [
			{
				id: "browse",
				label: "Browse presets…",
				description: names.length > 0 ? `${names.length} configured` : "none yet",
				currentValue: names.length > 0 ? `${names.length}` : "none",
				submenu: (_cv, subDone) => buildList(subDone),
			},
			{
				id: "new",
				label: "New preset…",
				description: "Run the wizard to define a new Mixture of Agents preset.",
				currentValue: "open",
				values: ["open"],
			},
		];
		const top = new SettingsList(
			topItems,
			Math.min(topItems.length + 2, 15),
			getSettingsListTheme(),
			(id) => {
				if (id === "new") exit({ kind: "new" });
			},
			() => done(undefined),
		);

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Mixture of Agents")), 1, 1));
		container.addChild(top);

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				top.handleInput?.(data);
				tui.requestRender();
			},
		};
	});

	// Menu closed. Run a staged modal action first (each saves + reloads on its
	// own); otherwise persist enabled/default deltas with a single reload.
	if (pending.value) {
		if (pending.value.kind === "new") {
			await configurePreset("", ctx);
		} else if (pending.value.kind === "edit") {
			await configurePreset(pending.value.name, ctx);
		} else if (pending.value.kind === "delete") {
			await deletePreset(pending.value.name, ctx);
		} else if (pending.value.kind === "rename") {
			await renamePresetInteractive(pending.value.name, ctx);
		}
		return;
	}

	let changed = false;
	const next = await loadConfigRaw();
	for (const name of names) {
		const target = next.presets?.[name];
		if (!target) continue;
		if ((target.enabled ?? true) !== working.enabled[name]) {
			target.enabled = working.enabled[name];
			changed = true;
		}
	}
	if (working.defaultPreset && (next.default_preset ?? names[0] ?? "") !== working.defaultPreset) {
		next.default_preset = working.defaultPreset;
		changed = true;
	}

	if (changed) {
		await saveConfig(next);
		ctx.ui.notify("Saved MoA changes. Reloading…", "info");
		await ctx.reload();
	}
}

async function runMoaCommand(args: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const prompt = args.trim();
	const setStatus = (text: string | undefined) =>
		(ctx as unknown as { ui: { setStatus: (k: string, t: string | undefined) => void } })
			.ui.setStatus(PROVIDER_NAME, formatStatus(text));

	if (!prompt) {
		ctx.ui.notify("Usage: /moa <prompt>  (runs refs + aggregator once, model unchanged)", "info");
		return;
	}

	try {
		setStatus("loading config…");
		const config = await loadConfig();
		const preset = resolvePreset(config);
		if (!preset) {
			setStatus(undefined);
			ctx.ui.notify("No MoA preset configured. Create ~/.pi/agent/moa.json (see README).", "warning");
			return;
		}

		const transcript = readTranscript(ctx);
		const advisory: AdvisoryMessage[] = [
			...trimForReferences(transcript as Parameters<typeof trimForReferences>[0]),
			{ role: "user", content: [{ type: "text", text: prompt }] },
		];

		const call = makeCallSlot(ctx);

		setStatus(`running ${preset.reference_models.length} reference model(s)…`);
		const { guidance } = await runPresetTurn({
			preset,
			advisory,
			call,
			mode: "oneshot",
			signal: (ctx as unknown as { signal?: AbortSignal }).signal,
			onProgress: (index, total, phase, label) => {
				if (phase === "ref-start") setStatus(`ref ${index + 1}/${total}: ${label}`);
				else if (phase === "aggregating") setStatus(`aggregating: ${label}`);
			},
		});
		setStatus(undefined);

		const message = guidance ? `${guidance}\n\n---\n\n${prompt}` : prompt;
		pi.sendUserMessage(message);
	} catch (e) {
		setStatus(undefined);
		const msg = e instanceof Error ? e.message : String(e);
		ctx.ui.notify(`MoA failed: ${msg}`, "error");
	}
}

function readTranscript(ctx: ExtensionContext): unknown[] {
	const sm = ctx.sessionManager as unknown as {
		getBranch?: () => unknown[];
		getEntries?: () => unknown[];
	};
	const branch = typeof sm.getBranch === "function" ? sm.getBranch() : undefined;
	if (Array.isArray(branch)) return branch;
	const entries = typeof sm.getEntries === "function" ? sm.getEntries() : undefined;
	return Array.isArray(entries) ? entries : [];
}

/** Enumerate models available in the live catalog as "provider/model" strings. */
function availableModelLabels(ctx: ExtensionContext): string[] {
	const all = (ctx.modelRegistry as unknown as { getAll?: () => Array<{ provider: string; id: string }> }).getAll?.() ?? [];
	return all.map((m) => `${m.provider}/${m.id}`);
}

/**
 * Searchable model picker, mirrors `/scoped-models` UX: a filter prompt up
 * top, a small scrollable window of matches, and a scroll indicator. Far
 * better than `ctx.ui.select` over the full catalog, which renders every
 * model at once. Returns the chosen `{provider, model}` or undefined on
 * cancel. Only invoked from `runMoaScreen`, which holds an
 * ExtensionCommandContext (the only ctx with `ui.custom`).
 */
async function pickModelSlot(
	ctx: ExtensionCommandContext,
	title: string,
	options: string[],
): Promise<{ provider: string; model: string } | undefined> {
	if (options.length === 0) {
		ctx.ui.notify("No models available in the catalog.", "warning");
		return undefined;
	}

	const sorted = [...options].sort((a, b) => a.localeCompare(b));
	// Mutable picker state, closed over by the render + handleInput closures.
	const state = { filter: "", index: 0, done: false };
	const maxVisible = 10;

	const filtered = () => {
		const q = state.filter.trim().toLowerCase();
		if (!q) return sorted;
		// Substring match on the full "provider/model" string, like
		// /scoped-models. Prefix-only (SelectList.setFilter) is too strict for
		// typing "opus" to find "claude/opus".
		return sorted.filter((o) => o.toLowerCase().includes(q));
	};

	const chosen = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const finish = (value: string | undefined) => {
			if (state.done) return;
			state.done = true;
			done(value);
		};

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 1));
		container.addChild(new Text(theme.fg("dim", "Type to filter · ↑↓ move · Enter confirm · Esc cancel"), 1, 1));

		const picker: Component = {
			render: (w: number) => {
				const lines: string[] = [];
				lines.push(theme.fg("muted", `> ${state.filter}`));
				lines.push("");
				const items = filtered();
				if (items.length === 0) {
					lines.push(theme.fg("muted", "  No models match."));
					return lines;
				}
				const start = Math.max(
					0,
					Math.min(state.index - Math.floor(maxVisible / 2), items.length - maxVisible),
				);
				const end = Math.min(start + maxVisible, items.length);
				for (let i = start; i < end; i++) {
					const sel = i === state.index;
					const prefix = sel ? "→ " : "  ";
					const body = sel ? theme.bold(items[i]) : items[i];
					lines.push(truncateToWidth(`${prefix}${body}`, w, ""));
				}
				if (start > 0 || end < items.length) {
					lines.push(theme.fg("dim", `  (${state.index + 1}/${items.length})`));
				}
				return lines;
			},
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				const kb = getKeybindings();
				const items = filtered();
				if (kb.matches(data, "tui.select.up")) {
					state.index = state.index <= 0 ? items.length - 1 : state.index - 1;
				} else if (kb.matches(data, "tui.select.down")) {
					state.index = items.length === 0 ? 0 : (state.index + 1) % items.length;
				} else if (kb.matches(data, "tui.select.confirm")) {
					const item = items[state.index];
					if (item) finish(item);
				} else if (kb.matches(data, "tui.select.cancel")) {
					finish(undefined);
				} else if (data === "\u007f" || data === "\b") {
					// Backspace: trim the filter.
					state.filter = state.filter.slice(0, -1);
					state.index = 0;
				} else if (data.length === 1 && data >= " ") {
					// Printable: extend the filter. Keep the cursor valid if the
					// window shrank.
					state.filter += data;
					state.index = 0;
				}
				tui.requestRender();
			},
		};
		container.addChild(picker);

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				picker.handleInput?.(data);
			},
		};
	});

	if (!chosen) return undefined;
	const idx = chosen.indexOf("/");
	if (idx <= 0) return undefined;
	return { provider: chosen.slice(0, idx), model: chosen.slice(idx + 1) };
}

async function configurePreset(nameArg: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify("/moa edit requires an interactive terminal.", "warning");
		return;
	}

	// New-preset wizard starts with the explainer (input dialogs can't show a
	// body, so the explanation is the first screen and naming follows). Editing
	// an existing preset skips it — the user already knows the recipe.
	const isNew = !nameArg;
	let name = nameArg;
	if (isNew) {
		const proceed = await ctx.ui.confirm(
			"New MoA preset",
			[
				"A Mixture of Agents preset runs several models over your prompt, then merges their answers into one reply.",
				"",
				"1. Aggregator (required): synthesizes the others and produces the final reply.",
				"2. Reference models (0-5, optional): extra perspectives run in parallel and feed the aggregator. Use small models to cut cost, or strong models to lift quality on hard tasks — your call.",
				"3. Enabled: when off, references are skipped and the aggregator runs alone.",
				"",
				"Pick models you already have configured in Pi. Continue?",
			].join("\n"),
		);
		if (!proceed) return;
		name = (await ctx.ui.input("Preset name", "default")) || "";
		if (!name) return;
		// Overwrite guard: a typed name may collide with an existing preset.
		const precheck = await loadConfigRaw();
		if (precheck.presets?.[name]) {
			const overwrite = await ctx.ui.confirm(`"${name}" already exists`, "Overwrite it?");
			if (!overwrite) return;
		}
	}

	const raw = await loadConfigRaw();
	const existing = raw.presets?.[name];

	const options = availableModelLabels(ctx);

	// Aggregator first (required).
	const aggregator = await pickModelSlot(ctx, `Aggregator for "${name}" — synthesizes refs, gives the final reply`, options);
	if (!aggregator) return;

	// References: ask how many, then pick each. Keep it simple (reviewer nit).
	const refCountStr = await ctx.ui.input(
		"Number of reference models (0 = aggregator alone)",
		String(existing?.reference_models?.length ?? 1),
	);
	const refCount = Math.max(0, Math.min(5, Number(refCountStr) || 0));

	const reference_models = [];
	for (let i = 0; i < refCount; i++) {
		const slot = await pickModelSlot(ctx, `Reference model ${i + 1} for "${name}" — runs in parallel, feeds the aggregator`, options);
		if (!slot) break;
		reference_models.push(slot);
	}
	// Partial-cancel guard: Esc on a later ref would otherwise silently save
	// fewer refs than the user requested.
	if (reference_models.length < refCount) {
		const accept = await ctx.ui.confirm(
			"Incomplete reference set",
			`Only ${reference_models.length} of ${refCount} reference models were picked. Save with ${reference_models.length}?`,
		);
		if (!accept) return;
	}

	const enabled = await ctx.ui.confirm(`Enable "${name}"?`, "On: refs fan out then aggregate. Off: aggregator alone.");

	const preset = { reference_models, aggregator, enabled };
	try {
		normalizePreset(name, preset); // validate (incl. recursion guard) before saving
	} catch (e) {
		ctx.ui.notify(`Invalid preset: ${e instanceof Error ? e.message : String(e)}`, "error");
		return;
	}

	const updated = upsertPreset(raw, name, preset);
	await saveConfig(updated);
	ctx.ui.notify(`Saved preset "${name}". Reloading…`, "info");
	await ctx.reload();
}

async function deletePreset(nameArg: string, ctx: ExtensionCommandContext): Promise<void> {
	const name = nameArg.trim();
	if (!name) return;

	const raw = await loadConfigRaw();
	if (!raw.presets?.[name]) {
		ctx.ui.notify(`No preset named "${name}".`, "warning");
		return;
	}

	const ok = await ctx.ui.confirm(`Delete "${name}"?`, "This cannot be undone.");
	if (!ok) return;

	const updated = removePreset(raw, name);
	await saveConfig(updated);
	ctx.ui.notify(`Deleted preset "${name}". Reloading…`, "info");
	await ctx.reload();
}

async function renamePresetInteractive(from: string, ctx: ExtensionCommandContext): Promise<void> {
	const raw = await loadConfigRaw();
	if (!raw.presets?.[from]) {
		ctx.ui.notify(`No preset named "${from}".`, "warning");
		return;
	}

	const to = (await ctx.ui.input("New preset name", from))?.trim();
	// Empty input, no-op rename, or cancel: bail silently.
	if (!to || to === from) return;

	const renamed = renamePreset(raw, from, to);
	if (!renamed) {
		ctx.ui.notify(`A preset named "${to}" already exists.`, "warning");
		return;
	}

	await saveConfig(renamed);
	ctx.ui.notify(`Renamed "${from}" → "${to}". Reloading…`, "info");
	await ctx.reload();
}

/** Load the raw (un-normalized) config so upsert/remove preserve user formatting. */
async function loadConfigRaw() {
	const { readFile } = await import("node:fs/promises");
	try {
		return JSON.parse(await readFile(userConfigPath(), "utf8")) as import("../lib/types").MoaConfig;
	} catch {
		return { default_preset: "default", presets: {} } as import("../lib/types").MoaConfig;
	}
}
