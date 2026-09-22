import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeWithCtx, firstText } from "./_helpers";
import { setConfirmWriteEnabled } from "../lib/confirm";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-slack-update-"));
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.SLACK_USER_TOKEN;
  vi.unstubAllGlobals();
});

function mockFetch(routes: Record<string, unknown>) {
  return vi.fn().mockImplementation((url: string) => {
    const method = new URL(url).pathname.replace("/api/", "");
    const body = routes[method];
    if (body === undefined) throw new Error(`unexpected Slack call: ${method}`);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response);
  });
}

function ctxWith(opts: { hasUI?: boolean; editorResult?: string | undefined }) {
  const editor = vi.fn().mockResolvedValue(opts.editorResult);
  return { ctx: { hasUI: opts.hasUI ?? true, ui: { confirm: vi.fn(), editor } }, editor };
}

describe("slack_update_message", () => {
  it("sends chat.update with the edited text", async () => {
    const fetchMock = mockFetch({ "chat.update": { ok: true, channel: "C1", ts: "100.0001", text: "new" } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = ctxWith({ editorResult: "new" });
    const { updateMessageTool } = await import("../lib/tools/update-message");
    const text = firstText(
      await invokeWithCtx(updateMessageTool, { channel: "C1", ts: "100.0001", text: "draft" }, ctx),
    );
    expect(text).toContain("updated");
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent).toEqual({ channel: "C1", ts: "100.0001", text: "new" });
  });

  it("cancels when the editor is dismissed", async () => {
    const fetchMock = mockFetch({ "chat.update": { ok: true } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = ctxWith({ editorResult: undefined });
    const { updateMessageTool } = await import("../lib/tools/update-message");
    const text = firstText(
      await invokeWithCtx(updateMessageTool, { channel: "C1", ts: "1", text: "draft" }, ctx),
    );
    expect(text).toMatch(/cancelled/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flags cant_update_message as an other-author issue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ ok: false, error: "cant_update_message" }),
        json: async () => ({ ok: false, error: "cant_update_message" }),
      } as unknown as Response),
    );
    const { ctx } = ctxWith({ editorResult: "x" });
    const { updateMessageTool } = await import("../lib/tools/update-message");
    const text = firstText(
      await invokeWithCtx(updateMessageTool, { channel: "C1", ts: "9", text: "x" }, ctx),
    );
    expect(text).toMatch(/only messages you authored|another user/);
  });

  it("reports a token/scope hint on an auth error (isAuthError branch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ ok: false, error: "invalid_auth" }),
        json: async () => ({ ok: false, error: "invalid_auth" }),
      } as unknown as Response),
    );
    const { ctx } = ctxWith({ editorResult: "x" });
    const { updateMessageTool } = await import("../lib/tools/update-message");
    const text = firstText(
      await invokeWithCtx(updateMessageTool, { channel: "C1", ts: "9", text: "x" }, ctx),
    );
    expect(text).toMatch(/token.*invalid|chat:write|scope/i);
  });

  it("skips the review when the flag is off", async () => {
    setConfirmWriteEnabled(false);
    const fetchMock = mockFetch({ "chat.update": { ok: true } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, editor } = ctxWith({ editorResult: "ignored" });
    const { updateMessageTool } = await import("../lib/tools/update-message");
    await invokeWithCtx(updateMessageTool, { channel: "C1", ts: "1", text: "draft" }, ctx);
    expect(editor).not.toHaveBeenCalled();
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.text).toBe("draft");
  });

  it("REFUSES to edit in headless mode by default", async () => {
    // No UI, no opt-in: the headless guard blocks before any review logic.
    // fetch must never be called.
    const fetchMock = mockFetch({ "chat.update": { ok: true } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, editor } = ctxWith({ hasUI: false });
    const { updateMessageTool } = await import("../lib/tools/update-message");
    const text = firstText(
      await invokeWithCtx(updateMessageTool, { channel: "C1", ts: "9", text: "draft" }, ctx),
    );
    expect(text).toMatch(/headless/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
  });
});
