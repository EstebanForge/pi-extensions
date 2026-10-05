import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  loadToolDisplayConfig,
  normalizeToolDisplayConfig,
  saveToolDisplayConfig,
} from "../lib/config-store";
import {
  detectToolDisplayPreset,
  getToolDisplayPresetConfig,
  TOOL_DISPLAY_PRESETS,
} from "../lib/presets";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../lib/types";

test("tidyCards defaults to on and normalizes non-boolean values to the default", () => {
  assert.equal(DEFAULT_TOOL_DISPLAY_CONFIG.tidyCards, true);
  assert.equal(normalizeToolDisplayConfig({}).tidyCards, true);
  assert.equal(normalizeToolDisplayConfig({ tidyCards: "no" }).tidyCards, true);
  assert.equal(normalizeToolDisplayConfig({ tidyCards: false }).tidyCards, false);
});

test("tidyCards survives a config save/load roundtrip", () => {
  const configFile = join(mkdtempSync(join(tmpdir(), "tool-display-")), "config.json");
  const saved = saveToolDisplayConfig(
    normalizeToolDisplayConfig({ ...DEFAULT_TOOL_DISPLAY_CONFIG, tidyCards: false }),
    configFile,
  );
  assert.equal(saved.success, true);
  assert.equal(loadToolDisplayConfig(configFile).config.tidyCards, false);
});

test("legacy config files without tidyCards keep tidy cards enabled", () => {
  assert.equal(normalizeToolDisplayConfig({ readOutputMode: "summary" }).tidyCards, true);
});

test("all presets ship tidy cards on and toggling them makes the config custom", () => {
  for (const preset of TOOL_DISPLAY_PRESETS) {
    assert.equal(getToolDisplayPresetConfig(preset).tidyCards, true);
    const toggled = { ...getToolDisplayPresetConfig(preset), tidyCards: false };
    assert.equal(detectToolDisplayPreset(toggled), "custom");
  }
});
