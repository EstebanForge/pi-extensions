import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import factory from "../extensions/index.js";
import { buildPriceIndex, lookupPrice } from "../extensions/index.js";

describe("price lookup", () => {
  const bundled = JSON.parse(
    readFileSync(join(fileURLToPath(new URL(import.meta.url)), "../../extensions/prices.json"), "utf8"),
  );

  it("bundled prices carry glm-5.3-flash at z.ai list rates", () => {
    // docs.z.ai/guides/overview/pricing, 2026-08-26: $0.15 in / $0.03 cached
    // / $0.50 out per 1M (50% launch promo to 2026-09-09; list encoded).
    const tier = bundled["glm-5.3-flash"];
    expect(tier).toBeDefined();
    expect(tier.i).toBe(0.15);
    expect(tier.c).toBe(0.03);
    expect(tier.o).toBe(0.5);
  });

  it("matches exact ids case-insensitively", () => {
    const idx = buildPriceIndex(bundled);
    expect(lookupPrice("GLM-5.3-Flash", idx)).toBe(bundled["glm-5.3-flash"]);
  });

  it("resolves z.ai [1m] coding-plan route suffixes to the base model's price", () => {
    // pi registers glm-5.3[1m] / glm-5.3-flash[1m] as distinct model ids and
    // the ledger records msg.model verbatim; "[1m]" is a routing suffix
    // (same model, same price), never a catalog SKU. Without the fallback,
    // every [1m] turn reports as unpriced ($0 + warning noise).
    const idx = buildPriceIndex(bundled);
    expect(lookupPrice("glm-5.3-flash[1m]", idx)).toBe(bundled["glm-5.3-flash"]);
    expect(lookupPrice("glm-5.3[1m]", idx)).toBe(bundled["glm-5.3"]);
    expect(lookupPrice("glm-5.2[1m]", idx)).toBe(bundled["glm-5.2"]);
  });

  it("still returns undefined for genuinely unknown models", () => {
    const idx = buildPriceIndex({ "glm-5.3": { i: 1, c: 1, o: 1 } });
    expect(lookupPrice("totally-unknown-model", idx)).toBeUndefined();
    expect(lookupPrice("", idx)).toBeUndefined();
  });
});

describe("pi-token-cost-ledger extension entry", () => {
  it("registers the token-cost-ledger command", async () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const pi: any = new Proxy(
      {
        registerTool: (def: any) => void tools.push(def?.name),
        registerCommand: (name: string) => void commands.push(name),
        getFlag: () => undefined,
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
      {
        get(target, prop) {
          return prop in target ? (target as any)[prop] : () => {};
        },
      },
    );

    await factory(pi);

    expect(commands).toContain("token-cost-ledger");
  });
});
