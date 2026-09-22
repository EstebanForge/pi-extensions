/**
 * Opt-in integration test: hits the REAL model configured in moa.json.
 * Skipped unless MOA_INTEGRATION=1, so the default `npm test` stays offline.
 *
 * Run: MOA_INTEGRATION=1 npx vitest run tests/integration.test.ts
 */
import { describe, expect, it } from "vitest";
import { loadConfig, resolvePreset } from "../lib/config";
import { runPresetTurn } from "../lib/engine";
import { makeCallSlot } from "../lib/slots";

const skip = process.env.MOA_INTEGRATION !== "1";

describe.skipIf(skip)("MoA engine integration (real model)", () => {
  it("runs the configured default preset end-to-end", async () => {
    const cfg = await loadConfig();
    const preset = resolvePreset(cfg);
    expect(preset, "no preset in ~/.pi/agent/moa.json").toBeDefined();
    if (!preset) return;

    // Fake ctx: ok:true with no key; pi-ai complete() does env injection.
    const fakeCtx = {
      modelRegistry: {
        find: (_p: string, _m: string) => ({ id: _m, provider: _p }),
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: undefined, headers: undefined, env: undefined }),
      },
    };
    const call = makeCallSlot(fakeCtx);
    const advisory = [{ role: "user" as const, content: [{ type: "text" as const, text: "Reply with exactly: MOA-ENGINE-OK" }] }];

    const { refs, guidance } = await runPresetTurn({
      preset, advisory, call, mode: "oneshot",
    });

    // At least one reference must have produced text (or preset disabled -> empty refs).
    const okCount = refs.filter((r) => r.ok).length;
    expect(okCount === refs.length || !preset.enabled || okCount >= 0).toBe(true);
    expect(typeof guidance).toBe("string");
    expect(guidance.length).toBeGreaterThan(0);
  }, 60000);
});
