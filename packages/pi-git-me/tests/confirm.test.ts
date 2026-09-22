// Confirm gate matrix. The gate is the heart of pi-git-me: it is the single
// piece of code that decides whether a write (commit, PR description, review
// comment) reaches git or gh, and on what terms. These tests pin the matrix:
//
//                              confirmWrite  allowHeadlessWrite
//                                  ON             ON | OFF
//   hasUI=true,  forced=false    PROCEED       PROCEED       (no prompt when confirmWrite=OFF)
//   hasUI=true,  forced=true     ASK (yes/no)  ASK (yes/no)
//   hasUI=false, forced=false    PROCEED       REFUSED
//   hasUI=false, forced=true     REFUSED       REFUSED
//
// confirmWrite defaults ON, allowHeadlessWrite defaults OFF. Every assertion
// uses a temp PI_CODING_AGENT_DIR so the on-disk settings file does not leak
// between cases (or to the real user state).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIRM_WRITE_FLAG,
  ALLOW_HEADLESS_WRITE_FLAG,
  confirmWrite,
  getAllowHeadlessWriteEnabled,
  getConfirmWriteEnabled,
  setAllowHeadlessWriteEnabled,
  setConfirmWriteEnabled,
} from "../lib/confirm";
import type { ConfirmContext } from "../lib/confirm";
import { makeStubUI } from "./_helpers";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-git-me-test-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

function ctxWith(ui: ReturnType<typeof makeStubUI>): ConfirmContext {
  return { hasUI: ui.hasUI, ui: ui.ui };
}

describe("confirm gate defaults", () => {
  it("confirmWrite defaults to ON", () => {
    expect(getConfirmWriteEnabled()).toBe(true);
  });

  it("allowHeadlessWrite defaults to OFF", () => {
    expect(getAllowHeadlessWriteEnabled()).toBe(false);
  });

  it("flag names match the documented public API", () => {
    expect(CONFIRM_WRITE_FLAG).toBe("git-confirm-write");
    expect(ALLOW_HEADLESS_WRITE_FLAG).toBe("git-allow-headless-write");
  });
});

describe("confirm gate - editable path (UI present, confirmWrite ON)", () => {
  it("returns the (possibly edited) text and records the prompt", async () => {
    const ui = makeStubUI({ editorResponse: "feat: tweaked" });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored - editor path)",
    });
    expect(outcome.proceed).toBe(true);
    expect(outcome.text).toBe("feat: tweaked");
    // The user changed the draft, so the gate must surface `edited: true` so
    // write tools can tell the agent its original wording did not ship.
    expect(outcome.edited).toBe(true);
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0]).toEqual({
      kind: "editor",
      title: "Commit?",
      body: "feat: original",
    });
  });

  it("editor returning undefined cancels (Esc) -> proceed=false", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored)",
    });
    expect(outcome.proceed).toBe(false);
    expect(outcome.text).toBeUndefined();
  });

  it("editor returning the prefill unchanged -> edited=false", async () => {
    const ui = makeStubUI({ editorResponse: "feat: original" });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored)",
    });
    expect(outcome.proceed).toBe(true);
    expect(outcome.text).toBe("feat: original");
    expect(outcome.edited).toBe(false);
  });

  it("normalize: a whitespace-only edit that trims away is NOT edited", async () => {
    const ui = makeStubUI({ editorResponse: "feat: original   " });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored)",
      normalize: (s) => s.trimEnd(),
    });
    expect(outcome.proceed).toBe(true);
    // text is the raw editor return; the flag reflects the NORMALIZED diff.
    expect(outcome.text).toBe("feat: original   ");
    expect(outcome.edited).toBe(false);
  });

  it("normalize: a real edit still reports edited=true", async () => {
    const ui = makeStubUI({ editorResponse: "feat: original (tweaked)" });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored)",
      normalize: (s) => s.trimEnd(),
    });
    expect(outcome.edited).toBe(true);
  });
});

describe("confirm gate - confirmWrite OFF (no prompt)", () => {
  it("skips the prompt and proceeds with the original text", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI();
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored)",
    });
    expect(outcome.proceed).toBe(true);
    expect(outcome.text).toBe("feat: original");
    // Gate off: no dialog opened, so the draft cannot have been edited.
    expect(outcome.edited).toBe(false);
    expect(ui.prompts).toHaveLength(0);
  });
});

describe("confirm gate - confirm() path (UI present, no editableText)", () => {
  it("yes/no answer drives proceed", async () => {
    const ui = makeStubUI({ confirmResponse: true });
    const ok = await confirmWrite(ctxWith(ui), {
      title: "Apply?",
      summary: "summary here",
    });
    expect(ok.proceed).toBe(true);
    expect(ui.prompts[0]).toEqual({ kind: "confirm", title: "Apply?", body: "summary here" });

    const ui2 = makeStubUI({ confirmResponse: false });
    const no = await confirmWrite(ctxWith(ui2), {
      title: "Apply?",
      summary: "summary here",
    });
    expect(no.proceed).toBe(false);
  });
});

describe("confirm gate - HEADLESS guard", () => {
  it("headless + confirmWrite ON + headless opt-in OFF -> refused", async () => {
    setAllowHeadlessWriteEnabled(false);
    const ui = makeStubUI({ hasUI: false });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored)",
    });
    expect(outcome.proceed).toBe(false);
    expect(ui.prompts).toHaveLength(0);
  });

  it("headless + headless opt-in ON -> proceeds without prompt", async () => {
    setAllowHeadlessWriteEnabled(true);
    const ui = makeStubUI({ hasUI: false });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored)",
    });
    expect(outcome.proceed).toBe(true);
    expect(outcome.text).toBe("feat: original");
    // Headless fast path: no human reviewed it, so edited is false.
    expect(outcome.edited).toBe(false);
    expect(ui.prompts).toHaveLength(0);
  });

  it("headless + forced (destructive) -> ALWAYS refused, no opt-in", async () => {
    setAllowHeadlessWriteEnabled(true);
    const ui = makeStubUI({ hasUI: false });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Force push?",
      summary: "destructive",
      requireInteractive: true,
    });
    expect(outcome.proceed).toBe(false);
    expect(ui.prompts).toHaveLength(0);
  });
});

describe("confirm gate - forced (requireInteractive) overrides flag", () => {
  it("with UI present, forces a confirm even when confirmWrite is OFF", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ confirmResponse: true });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Destructive?",
      summary: "this is irreversible",
      requireInteractive: true,
    });
    expect(outcome.proceed).toBe(true);
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].kind).toBe("confirm");
  });

  it("with UI present and user says no -> refused", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ confirmResponse: false });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Destructive?",
      summary: "this is irreversible",
      requireInteractive: true,
    });
    expect(outcome.proceed).toBe(false);
  });
});

describe("settings persistence", () => {
  it("setters are read-merge-write (toggling one does not clobber the other)", async () => {
    setConfirmWriteEnabled(false);
    setAllowHeadlessWriteEnabled(true);
    expect(getConfirmWriteEnabled()).toBe(false);
    expect(getAllowHeadlessWriteEnabled()).toBe(true);

    // Toggling confirm back to true must NOT reset the headless flag.
    setConfirmWriteEnabled(true);
    expect(getConfirmWriteEnabled()).toBe(true);
    expect(getAllowHeadlessWriteEnabled()).toBe(true);

    // And vice versa.
    setAllowHeadlessWriteEnabled(false);
    expect(getAllowHeadlessWriteEnabled()).toBe(false);
    expect(getConfirmWriteEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dialog serialization. pi's interactive UI shows ONE extension dialog at a
// time; an overlapping ctx.ui.confirm/editor call replaces the live dialog
// and the replaced promise never settles, so parallel gated tool calls (three
// git_commit calls in one batch) hang forever with their gates never shown.
// confirmWrite therefore holds a process-wide FIFO lock while a dialog is
// open. These tests pin the contract: no two dialogs overlap, order follows
// call order, and every caller resolves.
// ---------------------------------------------------------------------------

// UI whose dialogs stay open until the test releases them. Every open/close
// is recorded so overlap can be asserted exactly.
function makeGatedUI() {
  const events: string[] = [];
  const waiters: Array<() => void> = [];
  const releaseNext = () => waiters.shift()?.();
  const gate = () => new Promise<void>((resolve) => waiters.push(resolve));
  return {
    events,
    releaseNext,
    ui: {
      async confirm(title: string): Promise<boolean> {
        events.push(`open:${title}`);
        await gate();
        events.push(`close:${title}`);
        return true;
      },
      async editor(title: string): Promise<string | undefined> {
        events.push(`open:${title}`);
        await gate();
        events.push(`close:${title}`);
        return "human edited";
      },
    },
  };
}

// Flush pending microtasks so queued callers reach (or pass) their dialog
// before the next release.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("dialog serialization", () => {
  it("shows concurrent confirm() dialogs one at a time, in FIFO order", async () => {
    const { events, releaseNext, ui } = makeGatedUI();
    const ctx: ConfirmContext = { hasUI: true, ui };

    const calls = Promise.all([
      confirmWrite(ctx, { title: "one", summary: "s" }),
      confirmWrite(ctx, { title: "two", summary: "s" }),
      confirmWrite(ctx, { title: "three", summary: "s" }),
    ]);

    await settle();
    releaseNext();
    await settle();
    releaseNext();
    await settle();
    releaseNext();

    expect(await calls).toEqual([
      { proceed: true },
      { proceed: true },
      { proceed: true },
    ]);
    expect(events).toEqual([
      "open:one",
      "close:one",
      "open:two",
      "close:two",
      "open:three",
      "close:three",
    ]);
  });

  it("serializes mixed editor()/confirm() traffic", async () => {
    const { events, releaseNext, ui } = makeGatedUI();
    const ctx: ConfirmContext = { hasUI: true, ui };

    const calls = Promise.all([
      confirmWrite(ctx, { title: "a", editableText: "draft a", summary: "s" }),
      confirmWrite(ctx, { title: "b", summary: "s" }),
      confirmWrite(ctx, { title: "c", editableText: "draft c", summary: "s" }),
    ]);

    await settle();
    releaseNext();
    await settle();
    releaseNext();
    await settle();
    releaseNext();

    const outcomes = await calls;
    expect(outcomes[0]).toEqual({ proceed: true, text: "human edited", edited: true });
    expect(outcomes[1]).toEqual({ proceed: true });
    expect(outcomes[2]).toEqual({ proceed: true, text: "human edited", edited: true });
    expect(events).toEqual([
      "open:a",
      "close:a",
      "open:b",
      "close:b",
      "open:c",
      "close:c",
    ]);
  });

  it("shares one lock across modules via Symbol.for", () => {
    // Same key in every pi-*-me repo: one queue per pi process, so gates from
    // different extensions in one parallel batch serialize against each other.
    expect(
      (globalThis as Record<symbol, unknown>)[Symbol.for("pi-me.dialog-lock")],
    ).toBeDefined();
  });

  it("releases the lock when a dialog throws", async () => {
    const bombUI = {
      async confirm(): Promise<boolean> {
        throw new Error("boom");
      },
      async editor(): Promise<string | undefined> {
        return undefined;
      },
    };
    await expect(
      confirmWrite({ hasUI: true, ui: bombUI }, { title: "boom", summary: "s" }),
    ).rejects.toThrow("boom");

    // The queue must not stay wedged: the next caller still gets its dialog.
    const { events, releaseNext, ui } = makeGatedUI();
    const after = confirmWrite(
      { hasUI: true, ui } as ConfirmContext,
      { title: "after", summary: "s" },
    );
    await settle();
    releaseNext();
    expect(await after).toEqual({ proceed: true });
    expect(events).toEqual(["open:after", "close:after"]);
  });
});
