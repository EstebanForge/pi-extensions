/**
 * Wizard dialog blocked-status kinds: the preset wizard's flow confirms report
 * as "question" (pi 1.6.1 blockedKind), while the overwrite guard and the
 * destructive delete stay on the confirm() "permission" default.
 *
 * Drives the real configurePreset / deletePreset that the /moa screen's
 * pending-action queue dispatches, with a scripted fake ctx.ui. HOME points at
 * a temp dir so moa.json reads and writes never touch the real one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configurePreset, deletePreset } from "../extensions";

type ConfirmCall = { title: string; message: string; opts?: Record<string, unknown> };

interface Script {
  confirms: boolean[];
  inputs: string[];
  picks: (string | undefined)[];
}

function makeCtx(script: Script) {
  const confirms: ConfirmCall[] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    reload: async () => {},
    modelRegistry: {
      getAll: () => [
        { provider: "prov", id: "model-a" },
        { provider: "prov", id: "model-b" },
      ],
    },
    ui: {
      confirm: async (title: string, message: string, opts?: Record<string, unknown>) => {
        confirms.push({ title, message, opts });
        return script.confirms.shift() ?? true;
      },
      input: async () => script.inputs.shift() ?? "",
      custom: async () => script.picks.shift(),
      notify: async () => {},
    },
  };
  return { ctx, confirms };
}

describe("preset wizard dialog blocked kinds", () => {
  let home = "";
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "moa-wizard-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  function seedPreset(name = "alpha") {
    const dir = path.join(home, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "moa.json"),
      `${JSON.stringify(
        {
          default_preset: name,
          presets: {
            [name]: {
              aggregator: { provider: "prov", model: "model-a" },
              reference_models: [{ provider: "prov", model: "model-b" }],
              enabled: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  function userMoa(): { presets: Record<string, unknown> } | undefined {
    const file = path.join(home, ".pi", "agent", "moa.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  }

  it("new-preset explainer confirm reports as question", async () => {
    const { ctx, confirms } = makeCtx({ confirms: [false], inputs: [], picks: [] });

    await configurePreset("", ctx as never);

    expect(confirms).toHaveLength(1);
    expect(confirms[0].title).toBe("New MoA preset");
    expect(confirms[0].opts?.blockedKind).toBe("question");
    expect(userMoa()).toBeUndefined();
  });

  it("enable confirm reports as question; overwrite guard keeps the permission default", async () => {
    seedPreset();
    const { ctx, confirms } = makeCtx({
      confirms: [true, true, true],
      inputs: ["alpha", "0"],
      picks: ["prov/model-a"],
    });

    await configurePreset("", ctx as never);

    expect(confirms).toHaveLength(3);
    expect(confirms[0].opts?.blockedKind).toBe("question");
    expect(confirms[1].title).toContain("already exists");
    expect(confirms[1].opts?.blockedKind).toBeUndefined();
    expect(confirms[2].title).toContain('Enable "alpha"');
    expect(confirms[2].opts?.blockedKind).toBe("question");
    expect((userMoa()?.presets.alpha as { aggregator: unknown }).aggregator).toEqual({
      provider: "prov",
      model: "model-a",
    });
  });

  it("incomplete-reference confirm reports as question", async () => {
    seedPreset();
    const { ctx, confirms } = makeCtx({
      confirms: [true, true],
      inputs: ["1"],
      picks: ["prov/model-a", undefined],
    });

    await configurePreset("alpha", ctx as never);

    const incomplete = confirms.find((c) => c.title.startsWith("Incomplete reference set"));
    expect(incomplete).toBeDefined();
    expect(incomplete?.opts?.blockedKind).toBe("question");
    expect(confirms[confirms.length - 1].opts?.blockedKind).toBe("question");
    expect((userMoa()?.presets.alpha as { reference_models: string[] }).reference_models).toEqual([]);
  });

  it("delete confirm keeps the permission default", async () => {
    seedPreset();
    const { ctx, confirms } = makeCtx({ confirms: [true], inputs: [], picks: [] });

    await deletePreset("alpha", ctx as never);

    expect(confirms).toHaveLength(1);
    expect(confirms[0].title).toContain("Delete");
    expect(confirms[0].opts?.blockedKind).toBeUndefined();
    expect(userMoa()?.presets.alpha).toBeUndefined();
  });
});
