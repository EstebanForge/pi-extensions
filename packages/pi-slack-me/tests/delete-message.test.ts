import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeWithCtx, firstText } from "./_helpers";
import { setConfirmWriteEnabled } from "../lib/confirm";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-slack-delete-"));
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

function ctxWith(opts: { hasUI?: boolean; confirmResult?: boolean }) {
  const confirm = vi.fn().mockResolvedValue(opts.confirmResult);
  return { ctx: { hasUI: opts.hasUI ?? true, ui: { confirm, editor: vi.fn() } }, confirm };
}

describe("slack_delete_message", () => {
  it("sends chat.delete after yes/no confirm", async () => {
    const fetchMock = mockFetch({ "chat.delete": { ok: true, channel: "C1", ts: "100.0001" } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, confirm } = ctxWith({ confirmResult: true });
    const { deleteMessageTool } = await import("../lib/tools/delete-message");
    const text = firstText(
      await invokeWithCtx(deleteMessageTool, { channel: "C1", ts: "100.0001" }, ctx),
    );
    expect(text).toContain("deleted");
    expect(confirm).toHaveBeenCalledOnce();
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent).toEqual({ channel: "C1", ts: "100.0001" });
  });

  it("aborts when the user says no", async () => {
    const fetchMock = mockFetch({ "chat.delete": { ok: true } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = ctxWith({ confirmResult: false });
    const { deleteMessageTool } = await import("../lib/tools/delete-message");
    const text = firstText(
      await invokeWithCtx(deleteMessageTool, { channel: "C1", ts: "9" }, ctx),
    );
    expect(text).toMatch(/cancelled.*NOT deleted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is BLOCKED in headless mode (never runs a delete blind)", async () => {
    const fetchMock = mockFetch({ "chat.delete": { ok: true } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, confirm } = ctxWith({ hasUI: false, confirmResult: true });
    const { deleteMessageTool } = await import("../lib/tools/delete-message");
    const text = firstText(
      await invokeWithCtx(deleteMessageTool, { channel: "C1", ts: "9" }, ctx),
    );
    expect(text).toMatch(/NOT deleted/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirms even when the flag is OFF (forced)", async () => {
    setConfirmWriteEnabled(false);
    const fetchMock = mockFetch({ "chat.delete": { ok: true, channel: "C1", ts: "9" } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, confirm } = ctxWith({ confirmResult: true });
    const { deleteMessageTool } = await import("../lib/tools/delete-message");
    const text = firstText(
      await invokeWithCtx(deleteMessageTool, { channel: "C1", ts: "9" }, ctx),
    );
    expect(text).toContain("deleted");
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("reports a token/scope hint on an auth error (isAuthError branch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ ok: false, error: "token_revoked" }),
        json: async () => ({ ok: false, error: "token_revoked" }),
      } as unknown as Response),
    );
    const { ctx } = ctxWith({ confirmResult: true });
    const { deleteMessageTool } = await import("../lib/tools/delete-message");
    const text = firstText(
      await invokeWithCtx(deleteMessageTool, { channel: "C1", ts: "9" }, ctx),
    );
    expect(text).toMatch(/token.*invalid|revoked|chat:write|scope/i);
  });
});
