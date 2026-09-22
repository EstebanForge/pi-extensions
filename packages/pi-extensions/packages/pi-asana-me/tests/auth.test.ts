import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

beforeEach(async () => {
  // Strip any token leaked from a previous test before exercising the env code path.
  delete process.env.ASANA_ACCESS_TOKEN;
  // Force a fresh module import each test so the in-process 60s token cache
  // does not leak values across tests in this file.
  vi.resetModules();
});

afterEach(() => {
  delete process.env.ASANA_ACCESS_TOKEN;
  vi.unstubAllGlobals();
});

describe("getAsanaToken", () => {
  it("returns the trimmed env value when ASANA_ACCESS_TOKEN is set", async () => {
    process.env.ASANA_ACCESS_TOKEN = "  pat-with-whitespace  ";
    const { getAsanaToken } = await import("../lib/auth");
    expect(getAsanaToken()).toBe("pat-with-whitespace");
  });

  it("throws AsanaAuthError when ASANA_ACCESS_TOKEN is missing", async () => {
    const { getAsanaToken, AsanaAuthError } = await import("../lib/auth");
    expect(() => getAsanaToken()).toThrow(AsanaAuthError);
  });

  it("errors message points the user at the PAT-generation URL", async () => {
    const { getAsanaToken, AsanaAuthError } = await import("../lib/auth");
    try {
      getAsanaToken();
      expect.unreachable("expected AsanaAuthError");
    } catch (err) {
      expect(err).toBeInstanceOf(AsanaAuthError);
      expect((err as Error).message).toMatch(/app\.asana\.com\/0\/my-apps/);
      expect((err as Error).message).toMatch(/ASANA_ACCESS_TOKEN/);
    }
  });

  it("empty string is treated as missing", async () => {
    process.env.ASANA_ACCESS_TOKEN = "";
    const { getAsanaToken, AsanaAuthError } = await import("../lib/auth");
    expect(() => getAsanaToken()).toThrow(AsanaAuthError);
  });

  it("_resetAuthCache wipes the cache so re-evaluating env takes effect", async () => {
    process.env.ASANA_ACCESS_TOKEN = "first";
    const mod = await import("../lib/auth");
    expect(mod.getAsanaToken()).toBe("first");
    process.env.ASANA_ACCESS_TOKEN = "second";
    // Cache hit returns the first value if not reset.
    expect(mod.getAsanaToken()).toBe("first");
    mod._resetAuthCache();
    expect(mod.getAsanaToken()).toBe("second");
  });
});
