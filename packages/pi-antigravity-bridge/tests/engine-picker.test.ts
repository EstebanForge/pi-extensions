// Engine picker tests: the first-run predicate and the picker copy/order.
// The overlay itself is TUI-bound; its logic lives in the two exports below.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	agyMissingMessage,
	ENGINE_PICKER_ITEMS,
	ENGINE_PICKER_INTRO,
	ENGINE_SETTINGS_ROW_ID,
	engineSettingsRow,
	isAgyInstalled,
	savedEngineMessage,
	shouldOfferEnginePicker,
	showEnginePicker,
	toEngine,
} from "../src/engine-picker.js";

function tmpConfig(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-picker-")), "config.json");
}

test("picker: first run (no config file, no env) offers the picker", () => {
	const p = tmpConfig();
	try {
		assert.equal(shouldOfferEnginePicker(p, {}), true);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("picker: existing config file suppresses the picker", () => {
	const p = tmpConfig();
	try {
		fs.writeFileSync(p, "{}\n");
		assert.equal(shouldOfferEnginePicker(p, {}), false);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("picker: AGY_ENGINE env suppresses the picker even on a fresh install", () => {
	const p = tmpConfig();
	try {
		assert.equal(shouldOfferEnginePicker(p, { AGY_ENGINE: "acp" }), false);
		assert.equal(shouldOfferEnginePicker(p, { AGY_ENGINE: "" }), false);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("picker: acp is the first (default preselected) option", () => {
	assert.equal(ENGINE_PICKER_ITEMS.length, 2);
	assert.equal(ENGINE_PICKER_ITEMS[0]?.value, "acp");
	assert.equal(ENGINE_PICKER_ITEMS[1]?.value, "stream-json");
});

test("picker: only the exact engine literals count; anything else falls to the acp default", () => {
	assert.equal(toEngine("acp"), "acp");
	assert.equal(toEngine("stream-json"), "stream-json");
	assert.equal(toEngine("acp "), "acp");
	assert.equal(toEngine("sqlite"), "acp");
});

test("picker: saved-engine toast names the download-now and sign-in promise", () => {
	assert.match(savedEngineMessage("stream-json"), /Restart pi to apply/);
	const acp = savedEngineMessage("acp");
	// The pick must promise immediacy: download starts now, sign-in follows
	// it, only the engine switch waits for the restart.
	assert.match(acp, /~1\.5 GB/);
	assert.match(acp, /downloads now/);
	assert.match(acp, /sign-in opens when it lands/);
	assert.match(acp, /Restart applies the engine/);
});

test("picker: showEnginePicker resolves the picked engine, undefined on esc", async () => {
	// Captured ui.custom fake: hand the view the keys SelectList answers to.
	// ExtensionUIContext is structural here; only custom() is exercised.
	const capture = (): { ui: unknown; view: () => { handleInput(data: string): void } } => {
		let captured: { handleInput(data: string): void } | undefined;
		const ui = {
			custom: (
				factory: (host: unknown, theme: unknown, keys: unknown, done: (v: unknown) => void) => unknown,
			) =>
				new Promise<unknown>((resolve) => {
					const done = (value: unknown) => resolve(value);
					const host = { requestRender() {}, terminal: { rows: 24 } };
					captured = factory(host, { fg: (_c: string, t: string) => t }, undefined, done) as {
						handleInput(data: string): void;
					};
				}),
		};
		return { ui, view: () => captured! };
	};

	const enter = capture();
	const enterPick = showEnginePicker(enter.ui as never);
	await Promise.resolve();
	enter.view().handleInput("\r");
	assert.equal(await enterPick, "acp"); // first item, the default engine

	const esc = capture();
	const escPick = showEnginePicker(esc.ui as never);
	await Promise.resolve();
	esc.view().handleInput("\x1b");
	assert.equal(await escPick, undefined);
});

test("picker: agy binary detection covers PATH and explicit paths", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-"));
	try {
		const fake = path.join(dir, "agy");
		fs.writeFileSync(fake, "#!/bin/sh\n");
		fs.chmodSync(fake, 0o755);
		assert.equal(isAgyInstalled("agy", { PATH: `${dir}:/usr/bin` }), true);
		assert.equal(isAgyInstalled("agy", { PATH: "/usr/bin" }), false);
		assert.equal(isAgyInstalled("agy", { PATH: "" }), false);
		assert.equal(isAgyInstalled(fake, { PATH: "" }), true);
		assert.equal(isAgyInstalled(path.join(dir, "nope"), {}), false);
		assert.equal(isAgyInstalled(dir, { PATH: "" }), false); // a dir is not a file
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("picker: missing-agy toast carries the official install URL", () => {
	assert.match(agyMissingMessage(), /https:\/\/antigravity\.google\/product\/antigravity-cli/);
	assert.match(agyMissingMessage(), /[Ll]og in/);
});

test("picker: intro explains both engines' constraints", () => {
	assert.match(ENGINE_PICKER_INTRO, /agy` CLI/);
	assert.match(ENGINE_PICKER_INTRO, /authenticated/);
	assert.match(ENGINE_PICKER_INTRO, /official server/);
	assert.match(ENGINE_PICKER_INTRO, /second Google sign-in/);
	// The download is the ACP engine's main cost; the pin keeps it disclosed.
	assert.match(ENGINE_PICKER_INTRO, /~1\.5 GB/);
	assert.match(ENGINE_PICKER_INTRO, /unavoidable/);
	assert.match(ENGINE_PICKER_INTRO, /\/agy engine/);
	// Tool-result images ride BOTH engines since the gate widening
	// (probe-verified 2026-09-07); the old "adds image input" claim painted
	// an ACP advantage that no longer exists. Keep it out.
	assert.doesNotMatch(ENGINE_PICKER_INTRO, /[Aa]dds image/);
});

test("settings action row: value-less, so Enter resolves the menu instead of cycling", () => {
	// DialogMenu contract: a row with `values` cycles in place on Enter; a row
	// with neither values nor onEdit resolves the menu with its id. The engine
	// row must be the second kind: Enter closes settings and opens the picker.
	for (const engine of ["stream-json", "acp"] as const) {
		const row = engineSettingsRow(engine);
		assert.equal(row.id, ENGINE_SETTINGS_ROW_ID);
		assert.equal(row.values, undefined);
		assert.equal(row.currentValue, engine);
		assert.match(row.label, /[Ss]witch engine/);
		assert.match(row.description ?? "", /[Rr]estart/);
	}
});
