import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmWrite,
  summarizePostMessage,
  summarizeUpdateMessage,
  summarizeDeleteMessage,
  setConfirmWriteEnabled,
  setAllowHeadlessWriteEnabled,
  getConfirmWriteEnabled,
  getAllowHeadlessWriteEnabled,
  getSettingsPath,
  CONFIRM_WRITE_FLAG,
  ALLOW_HEADLESS_WRITE_FLAG,
  type ConfirmContext,
} from "../lib/confirm";

// The gate reads file-backed module state at <piDir>/pi-slack-me.json. Redirect
// PI_CODING_AGENT_DIR to a per-test tmp dir so tests never touch the real
// ~/.pi/agent and start from a known (no-file -> default ON) state.
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-slack-me-test-"));
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
  it("review disabled WITH a UI -> proceeds without touching UI (fast path)", async () => {
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

  it("editable path: editor() accept returns the EDITED text", async () => {
    setConfirmWriteEnabled(true);
    const { ctx, editor, confirm } = mockCtx({ editorResult: "trimmed draft" });
    const out = await confirmWrite(ctx, {
      title: "Send message?",
      editableText: "verbose draft",
      summary: "s",
    });
    expect(out.proceed).toBe(true);
    expect(out.text).toBe("trimmed draft");
    // The user changed the draft in the dialog, so edited must be true.
    expect(out.edited).toBe(true);
    expect(editor).toHaveBeenCalledWith("Send message?", "verbose draft");
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
    const out = await confirmWrite(ctx, { title: "Delete?", summary: "permanent" });
    expect(out.proceed).toBe(true);
    expect(confirm).toHaveBeenCalledWith("Delete?", "permanent");
    expect(editor).not.toHaveBeenCalled();
  });

  it("non-editable path: confirm() false aborts", async () => {
    setConfirmWriteEnabled(true);
    const { ctx } = mockCtx({ confirmResult: false });
    const out = await confirmWrite(ctx, { title: "t", summary: "s" });
    expect(out.proceed).toBe(false);
  });

  it("flag constant is stable", () => {
    expect(CONFIRM_WRITE_FLAG).toBe("slack-confirm-write");
    expect(ALLOW_HEADLESS_WRITE_FLAG).toBe("slack-allow-headless-write");
  });
});

describe("confirmWrite headless guard (independent of review flag)", () => {
  it("post/update in headless -> BLOCKED by default (no opt-in)", async () => {
    setConfirmWriteEnabled(true);
    const { ctx, editor, confirm } = mockCtx({ hasUI: false, editorResult: "x" });
    const out = await confirmWrite(ctx, {
      title: "t",
      editableText: "draft",
      summary: "s",
    });
    expect(out.proceed).toBe(false);
    expect(editor).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("post/update in headless -> BLOCKED even when review flag is OFF", async () => {
    setConfirmWriteEnabled(false);
    const { ctx } = mockCtx({ hasUI: false });
    const out = await confirmWrite(ctx, { title: "t", editableText: "d", summary: "s" });
    expect(out.proceed).toBe(false);
  });

  it("post/update in headless -> PROCEEDS when slack-allow-headless-write is ON", async () => {
    setAllowHeadlessWriteEnabled(true);
    const { ctx, editor } = mockCtx({ hasUI: false, editorResult: "x" });
    const out = await confirmWrite(ctx, { title: "t", editableText: "draft", summary: "s" });
    expect(out.proceed).toBe(true);
    expect(out.text).toBe("draft");
    // Headless fast path: no human reviewed it, so edited is false.
    expect(out.edited).toBe(false);
    expect(editor).not.toHaveBeenCalled();
  });

  it("delete (requireInteractive) is ALWAYS blocked headless, even with the opt-in", async () => {
    setAllowHeadlessWriteEnabled(true);
    const { ctx, confirm } = mockCtx({ hasUI: false, confirmResult: true });
    const out = await confirmWrite(ctx, {
      title: "Delete?",
      summary: "s",
      requireInteractive: true,
    });
    expect(out.proceed).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("confirmWrite requireInteractive (destructive writes)", () => {
  it("confirms even when the flag is OFF (force overrides flag)", async () => {
    setConfirmWriteEnabled(false);
    const { ctx, confirm } = mockCtx({ confirmResult: true });
    const out = await confirmWrite(ctx, {
      title: "Delete?",
      summary: "s",
      requireInteractive: true,
    });
    expect(out.proceed).toBe(true);
    expect(confirm).toHaveBeenCalledWith("Delete?", "s");
  });

  it("BLOCKS in headless mode when no UI can confirm (never runs a delete blind)", async () => {
    setConfirmWriteEnabled(true);
    const { ctx, confirm } = mockCtx({ hasUI: false, confirmResult: true });
    const out = await confirmWrite(ctx, {
      title: "Delete?",
      summary: "s",
      requireInteractive: true,
    });
    expect(out.proceed).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirm() false aborts a forced write", async () => {
    const { ctx } = mockCtx({ confirmResult: false });
    const out = await confirmWrite(ctx, { title: "t", summary: "s", requireInteractive: true });
    expect(out.proceed).toBe(false);
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
    writeFileSync(getSettingsPath(), JSON.stringify({ confirmWrite: false }), "utf8");
    expect(getConfirmWriteEnabled()).toBe(false);
  });

  it("falls back to the safe default (ON) on a corrupt settings file", () => {
    writeFileSync(getSettingsPath(), "{ this is not valid json", "utf8");
    expect(getConfirmWriteEnabled()).toBe(true);
  });

  it("ignores an unrelated confirmWrite=true-but-wrong-type value safely", () => {
    writeFileSync(getSettingsPath(), JSON.stringify({ confirmWrite: "no" }), "utf8");
    expect(getConfirmWriteEnabled()).toBe(true);
  });

  it("settings path lives under PI_CODING_AGENT_DIR as pi-slack-me.json", () => {
    expect(getSettingsPath()).toBe(join(tmpDir, "pi-slack-me.json"));
  });

  it("toggling one flag does NOT clobber the other (read-merge-write)", () => {
    // Regression guard: the setters do read-merge-write so persisting
    // confirmWrite preserves allowHeadlessWrite and vice versa.
    setConfirmWriteEnabled(false);
    setAllowHeadlessWriteEnabled(true);
    setConfirmWriteEnabled(true); // would clobber allowHeadlessWrite if not merged
    expect(getConfirmWriteEnabled()).toBe(true);
    expect(getAllowHeadlessWriteEnabled()).toBe(true);
    const raw = JSON.parse(readFileSync(getSettingsPath(), "utf8"));
    expect(raw).toEqual({ confirmWrite: true, allowHeadlessWrite: true });
  });

  it("allowHeadlessWrite defaults OFF and only an explicit literal true enables it", () => {
    expect(getAllowHeadlessWriteEnabled()).toBe(false);
    writeFileSync(getSettingsPath(), JSON.stringify({ allowHeadlessWrite: "yes" }), "utf8");
    expect(getAllowHeadlessWriteEnabled()).toBe(false);
    setAllowHeadlessWriteEnabled(true);
    expect(getAllowHeadlessWriteEnabled()).toBe(true);
  });
});

describe("summarizePostMessage", () => {
  it("renders DM target when to_user is set", () => {
    const s = summarizePostMessage({ toUser: "U123", text: "hello world" });
    expect(s).toContain("@U123 (DM)");
    expect(s).toContain("hello world");
    expect(s).not.toContain("thread=");
  });

  it("renders channel target and thread", () => {
    const s = summarizePostMessage({
      channel: "C1",
      threadTs: "100.0001",
      text: "reply",
    });
    expect(s).toContain("to: C1");
    expect(s).toContain("thread=100.0001");
    expect(s).toContain("reply");
  });

  it("truncates long text to the preview cap", () => {
    const long = "x".repeat(300);
    const s = summarizePostMessage({ channel: "C1", text: long });
    expect(s).toContain("...");
    expect(s.length).toBeLessThan(long.length + 60);
  });
});

describe("summarizeUpdateMessage", () => {
  it("renders channel + ts + text", () => {
    const s = summarizeUpdateMessage({ channel: "C9", ts: "100.0001", text: "fixed" });
    expect(s).toContain("channel: C9");
    expect(s).toContain("ts: 100.0001");
    expect(s).toContain("fixed");
  });
});

describe("summarizeDeleteMessage", () => {
  it("warns that the delete is permanent", () => {
    const s = summarizeDeleteMessage({ channel: "C9", ts: "100.0001" });
    expect(s).toContain("channel: C9");
    expect(s).toContain("ts: 100.0001");
    expect(s).toMatch(/permanent|cannot be undone/);
  });
});

// ---------------------------------------------------------------------------
// Dialog serialization. pi's interactive UI shows ONE extension dialog at a
// time; an overlapping ctx.ui.confirm/editor call replaces the live dialog
// and the replaced promise never settles, so parallel gated tool calls (three
// slack_post_message calls in one batch) hang forever with their gates never
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
