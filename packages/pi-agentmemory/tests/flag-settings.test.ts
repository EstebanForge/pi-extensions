// Tests for the file-backed flag settings persistence, pointed at a temp
// PI_CODING_AGENT_DIR so the real ~/.pi/agent settings are never touched.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSettingsPath,
  loadFlagSettings,
  saveFlagSetting,
} from "../extensions/agentmemory/flag-settings.js";

describe("flag settings persistence", () => {
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentmemory-flags-"));
    prevEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists and loads a string flag", () => {
    expect(saveFlagSetting("agentmemory-watchdog-interval", "10")).toBe(true);
    expect(loadFlagSettings()).toEqual({ "agentmemory-watchdog-interval": "10" });
    expect(getSettingsPath()).toBe(join(dir, "pi-agentmemory.json"));
  });

  it("merges string and boolean flags without clobbering siblings", () => {
    expect(saveFlagSetting("agentmemory-autostart", true)).toBe(true);
    expect(saveFlagSetting("agentmemory-watchdog-interval", "off")).toBe(true);
    expect(loadFlagSettings()).toEqual({
      "agentmemory-autostart": true,
      "agentmemory-watchdog-interval": "off",
    });
  });

  it("keeps a saved value when another write fails shape checks", () => {
    expect(saveFlagSetting("agentmemory-watchdog", false)).toBe(true);
    // loadFlagSettings drops non-boolean/string entries defensively.
    expect(saveFlagSetting("agentmemory-watchdog-interval", "0.5")).toBe(true);
    const loaded = loadFlagSettings();
    expect(loaded["agentmemory-watchdog"]).toBe(false);
    expect(loaded["agentmemory-watchdog-interval"]).toBe("0.5");
  });
});
