import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmWrite,
  summarizeCreateTasks,
  summarizeUpdateTasks,
  willPromptForWrite,
  setConfirmWriteEnabled,
  getConfirmWriteEnabled,
  getSettingsPath,
  CONFIRM_WRITE_FLAG,
  type ConfirmContext,
} from "../lib/confirm";

// The gate reads file-backed module state at <piDir>/pi-asana-me.json. Redirect
// PI_CODING_AGENT_DIR to a per-test tmp dir so tests never touch the real
// ~/.pi/agent and start from a known (no-file -> default ON) state. Each test
// also clears the module cache via setConfirmWriteEnabled so cached state
// doesn't leak across the boolean cases.
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-asana-me-test-"));
  process.env.PI_CODING_AGENT_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

function mockCtx(opts: {
  hasUI?: boolean;
  editorResult?: string | undefined;
  confirmResult?: boolean;
}): { ctx: ConfirmContext; editor: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> } {
  const editor = vi.fn().mockResolvedValue(opts.editorResult);
  const confirm = vi.fn().mockResolvedValue(opts.confirmResult);
  const ctx: ConfirmContext = { hasUI: opts.hasUI ?? true, ui: { confirm, editor } };
  return { ctx, editor, confirm };
}

describe("confirmWrite gate", () => {
  it("review disabled -> proceeds without touching UI (fast path)", async () => {
    setConfirmWriteEnabled(false);
    const { ctx, editor, confirm } = mockCtx({ editorResult: "x" });
    const out = await confirmWrite(ctx, {
      title: "t",
      editableText: "draft",
      summary: "s",
    });
    expect(out.proceed).toBe(true);
    expect(out.text).toBe("draft");
    // Fast path: no dialog opened, so the draft cannot have been edited.
    expect(out.edited).toBe(false);
    expect(editor).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("review enabled but no interactive UI -> proceeds (never blocks headless)", async () => {
    setConfirmWriteEnabled(true);
    const { ctx, editor, confirm } = mockCtx({ hasUI: false, editorResult: "x" });
    const out = await confirmWrite(ctx, {
      title: "t",
      editableText: "draft",
      summary: "s",
    });
    expect(out.proceed).toBe(true);
    // Headless fast path: no human reviewed it, so edited is false.
    expect(out.edited).toBe(false);
    expect(editor).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("editable path: editor() accept returns the EDITED text", async () => {
    setConfirmWriteEnabled(true);
    const { ctx, editor, confirm } = mockCtx({ editorResult: "trimmed draft" });
    const out = await confirmWrite(ctx, {
      title: "Post comment?",
      editableText: "verbose draft",
      summary: "s",
    });
    expect(out.proceed).toBe(true);
    expect(out.text).toBe("trimmed draft");
    // The user changed the draft in the dialog, so edited must be true.
    expect(out.edited).toBe(true);
    expect(editor).toHaveBeenCalledWith("Post comment?", "verbose draft");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("editable path: editor() returning the prefill unchanged -> edited=false", async () => {
    setConfirmWriteEnabled(true);
    const { ctx } = mockCtx({ editorResult: "draft" });
    const out = await confirmWrite(ctx, {
      title: "t",
      editableText: "draft",
      summary: "s",
    });
    expect(out.proceed).toBe(true);
    expect(out.text).toBe("draft");
    expect(out.edited).toBe(false);
  });

  it("editable path: editor() cancel (undefined) aborts the write", async () => {
    setConfirmWriteEnabled(true);
    const { ctx, editor, confirm } = mockCtx({ editorResult: undefined });
    const out = await confirmWrite(ctx, {
      title: "t",
      editableText: "draft",
      summary: "s",
    });
    expect(out.proceed).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("non-editable path: confirm() true proceeds", async () => {
    setConfirmWriteEnabled(true);
    const { ctx, editor, confirm } = mockCtx({ confirmResult: true });
    const out = await confirmWrite(ctx, {
      title: "Create 2 tasks?",
      summary: "tasks (2):\n  1. A",
    });
    expect(out.proceed).toBe(true);
    expect(confirm).toHaveBeenCalledWith("Create 2 tasks?", "tasks (2):\n  1. A");
    expect(editor).not.toHaveBeenCalled();
  });

  it("non-editable path: confirm() false aborts", async () => {
    setConfirmWriteEnabled(true);
    const { ctx } = mockCtx({ confirmResult: false });
    const out = await confirmWrite(ctx, { title: "t", summary: "s" });
    expect(out.proceed).toBe(false);
  });

  it("flag constant is stable", () => {
    expect(CONFIRM_WRITE_FLAG).toBe("asana-confirm-write");
  });
});

describe("persistence (file-backed state)", () => {
  it("defaults to ON when no settings file exists", () => {
    expect(existsSync(getSettingsPath())).toBe(false);
    expect(getConfirmWriteEnabled()).toBe(true);
  });

  it("setConfirmWriteEnabled writes the file and flips live state", () => {
    expect(setConfirmWriteEnabled(false)).toBe(true);
    expect(getConfirmWriteEnabled()).toBe(false);
    const raw = JSON.parse(readFileSync(getSettingsPath(), "utf8"));
    expect(raw).toEqual({ confirmWrite: false });
  });

  it("setConfirmWriteEnabled(true) round-trips back to ON", () => {
    setConfirmWriteEnabled(false);
    expect(setConfirmWriteEnabled(true)).toBe(true);
    expect(getConfirmWriteEnabled()).toBe(true);
  });

  it("reads the on-disk value on first access in a fresh process", () => {
    // Simulate a pre-existing settings file written by a previous session.
    writeFileSync(getSettingsPath(), JSON.stringify({ confirmWrite: false }), "utf8");
    expect(getConfirmWriteEnabled()).toBe(false);
  });

  it("falls back to the safe default (ON) on a corrupt settings file", () => {
    writeFileSync(getSettingsPath(), "{ this is not valid json", "utf8");
    expect(getConfirmWriteEnabled()).toBe(true);
  });

  it("ignores an unrelated confirmWrite=true-but-wrong-type value safely", () => {
    // Only an explicit literal false disables; anything else -> default ON.
    writeFileSync(getSettingsPath(), JSON.stringify({ confirmWrite: "no" }), "utf8");
    expect(getConfirmWriteEnabled()).toBe(true);
  });

  it("settings path lives under PI_CODING_AGENT_DIR", () => {
    expect(getSettingsPath()).toBe(join(tmpDir, "pi-asana-me.json"));
  });
});

describe("summarizeCreateTasks", () => {
  it("renders workspace + per-task key fields", () => {
    const s = summarizeCreateTasks("ws1", [
      { name: "A", assignee: "me", due_on: "2026-12-31" },
      { name: "B", project: "p1", section: "s1" },
    ]);
    expect(s).toContain("workspace: ws1");
    expect(s).toContain("tasks (2):");
    expect(s).toContain("1. A  |  assignee=me  |  due=2026-12-31");
    expect(s).toContain("2. B  |  project=p1  |  section=s1");
  });

  it("renders a resolved parent as name + URL so subtask landings are readable", () => {
    const resolved = new Map([
      ["999", { name: "Epic: Auth", permalink_url: "https://app.asana.com/0/1/999" }],
    ]);
    const s = summarizeCreateTasks(undefined, [{ name: "Sub", parent: "999" }], resolved);
    expect(s).toContain("1. Sub  |  parent='Epic: Auth' (https://app.asana.com/0/1/999)");
  });

  it("caps the preview at 10 tasks", () => {
    const tasks = Array.from({ length: 15 }, (_, i) => ({ name: `T${i}` }));
    const s = summarizeCreateTasks(undefined, tasks);
    expect(s).toContain("tasks (15):");
    expect(s).toContain("...and 5 more");
    expect(s).not.toContain("T14");
  });

  it("uses projects[0] when only the array form is set", () => {
    const s = summarizeCreateTasks(undefined, [{ name: "X", projects: ["a", "b"] }]);
    expect(s).toContain("project=a");
  });
});

describe("summarizeUpdateTasks", () => {
  it("renders gid + changed fields, with complete/reopen shorthand", () => {
    const s = summarizeUpdateTasks([
      { gid: "111", completed: true },
      { gid: "222", name: "Renamed", assignee: "me", due_on: "2026-01-01" },
    ]);
    expect(s).toContain("updates (2):");
    expect(s).toContain("1. gid: 111  |  complete");
    expect(s).toContain('2. gid: 222  |  name="Renamed"  |  assignee=me  |  due=2026-01-01');
  });

  it("renders resolved task name + URL and resolves parent refs", () => {
    const resolved = new Map([
      ["111", { name: "Fix login", permalink_url: "https://app.asana.com/0/1/111" }],
      ["999", { name: "Epic: Auth", permalink_url: "https://app.asana.com/0/1/999" }],
    ]);
    const s = summarizeUpdateTasks([{ gid: "111", completed: true, parent: "999" }], resolved);
    expect(s).toContain("'Fix login' (https://app.asana.com/0/1/111)  |  complete");
    expect(s).toContain("parent='Epic: Auth' (https://app.asana.com/0/1/999)");
  });

  it("falls back to gid when name resolves but URL is missing", () => {
    const s = summarizeUpdateTasks(
      [{ gid: "111", completed: true }],
      new Map([["111", { name: "Fix login" }]]),
    );
    expect(s).toContain("'Fix login' (gid: 111)  |  complete");
  });
});

describe("willPromptForWrite", () => {
  it("is true only when the gate is on AND ctx has an interactive UI", () => {
    const withUi = { hasUI: true };
    const noUi = { hasUI: false };
    setConfirmWriteEnabled(true);
    expect(willPromptForWrite(withUi)).toBe(true);
    expect(willPromptForWrite(noUi)).toBe(false);
    setConfirmWriteEnabled(false);
    expect(willPromptForWrite(withUi)).toBe(false);
    expect(willPromptForWrite(noUi)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dialog serialization. pi's interactive UI shows ONE extension dialog at a
// time; an overlapping ctx.ui.confirm/editor call replaces the live dialog
// and the replaced promise never settles, so parallel gated tool calls (three
// asana_add_comment calls in one batch) hang forever with their gates never
// shown. confirmWrite therefore holds a process-wide FIFO lock while a dialog
// is open. These tests pin the contract: no two dialogs overlap, order
// follows call order, and every caller resolves.
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
  // Module state persists across tests in this file (earlier cases toggle the
  // review flag off); the serialization tests need the gate ON.
  beforeEach(() => {
    setConfirmWriteEnabled(true);
  });

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
