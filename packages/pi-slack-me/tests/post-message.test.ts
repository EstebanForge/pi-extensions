import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeWithCtx, firstText } from "./_helpers";
import { setConfirmWriteEnabled, setAllowHeadlessWriteEnabled } from "../lib/confirm";

// Write-tool tests. Each tool reads a tool-execution ctx (5th arg) for the
// review gate, so we use invokeWithCtx with a ctx stub. The gate flag is
// file-backed; redirect PI_CODING_AGENT_DIR to a tmp dir per test.

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-slack-post-"));
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.SLACK_USER_TOKEN;
  vi.unstubAllGlobals();
});

// POST-aware fetch mock: routes by Slack method derived from the URL path.
// Captures the JSON body so tests can assert what was actually sent.
function mockFetch(routes: Record<string, unknown>) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = u.pathname.replace("/api/", "");
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

function ctxWith(opts: {
  hasUI?: boolean;
  editorResult?: string | undefined;
  confirmResult?: boolean;
}) {
  const editor = vi.fn().mockResolvedValue(opts.editorResult);
  const confirm = vi.fn().mockResolvedValue(opts.confirmResult);
  return {
    ctx: { hasUI: opts.hasUI ?? true, ui: { confirm, editor } },
    editor,
    confirm,
  };
}

describe("slack_post_message", () => {
  it("requires channel or to_user", async () => {
    const { ctx } = ctxWith({ editorResult: "x" });
    const { postMessageTool } = await import("../lib/tools/post-message");
    const text = firstText(await invokeWithCtx(postMessageTool, { text: "hi" }, ctx));
    expect(text).toMatch(/channel.*to_user|required/);
  });

  it("REJECTS when both channel and to_user are set (no silent precedence)", async () => {
    const fetchMock = mockFetch({ "chat.postMessage": { ok: true } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = ctxWith({ editorResult: "x" });
    const { postMessageTool } = await import("../lib/tools/post-message");
    const text = firstText(
      await invokeWithCtx(postMessageTool, { channel: "C1", to_user: "U9", text: "hi" }, ctx),
    );
    expect(text).toMatch(/channel.*OR.*to_user|not both/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to a channel after the user accepts the editable review", async () => {
    const fetchMock = mockFetch({ "chat.postMessage": { ok: true, channel: "C1", ts: "100.0002" } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, editor } = ctxWith({ editorResult: "final text" });
    const { postMessageTool } = await import("../lib/tools/post-message");
    const result = await invokeWithCtx(postMessageTool, { channel: "C1", text: "draft" }, ctx);
    const text = firstText(result);
    expect(text).toContain("C1");
    expect(text).toContain("100.0002");
    // The editor opened with the drafted text.
    expect(editor).toHaveBeenCalledWith(expect.any(String), "draft");
    // The POST body used the EDITED text, not the draft.
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent).toEqual({ channel: "C1", text: "final text" });
    // The success result tells the agent exactly what shipped and that the
    // user changed the draft, so later turns do not trust the original wording.
    expect(text).toContain("Edited by user: yes");
    expect(text).toContain("Final content sent:");
    expect(text).toContain("final text");
    expect(result.details).toMatchObject({ postedContent: "final text", edited: true });
  });

  it("sends the edited text through unchanged when the user did not edit", async () => {
    const fetchMock = mockFetch({ "chat.postMessage": { ok: true, channel: "C1", ts: "1" } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = ctxWith({ editorResult: "as-is" });
    const { postMessageTool } = await import("../lib/tools/post-message");
    await invokeWithCtx(postMessageTool, { channel: "C1", text: "as-is" }, ctx);
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.text).toBe("as-is");
  });

  it("cancels (editor returns undefined) and posts nothing", async () => {
    const fetchMock = mockFetch({ "chat.postMessage": { ok: true } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = ctxWith({ editorResult: undefined });
    const { postMessageTool } = await import("../lib/tools/post-message");
    const text = firstText(await invokeWithCtx(postMessageTool, { channel: "C1", text: "draft" }, ctx));
    expect(text).toMatch(/cancelled/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a to_user DM via conversations.open then posts to the DM channel", async () => {
    const fetchMock = mockFetch({
      "conversations.open": { ok: true, channel: { id: "D77" } },
      "chat.postMessage": { ok: true, channel: "D77", ts: "2" },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = ctxWith({ editorResult: "hey" });
    const { postMessageTool } = await import("../lib/tools/post-message");
    const text = firstText(await invokeWithCtx(postMessageTool, { to_user: "U9", text: "hey" }, ctx));
    expect(text).toContain("@U9");
    expect(text).toContain("D77");
    const sent = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(sent).toEqual({ channel: "D77", text: "hey" });
  });

  it("includes thread_ts as a threaded reply", async () => {
    const fetchMock = mockFetch({ "chat.postMessage": { ok: true, channel: "C1", ts: "3" } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = ctxWith({ editorResult: "reply" });
    const { postMessageTool } = await import("../lib/tools/post-message");
    const text = firstText(
      await invokeWithCtx(postMessageTool, { channel: "C1", thread_ts: "100.0001", text: "reply" }, ctx),
    );
    expect(text).toMatch(/threaded reply/);
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.thread_ts).toBe("100.0001");
  });

  it("skips the review dialog when the flag is off (fast path)", async () => {
    setConfirmWriteEnabled(false);
    const fetchMock = mockFetch({ "chat.postMessage": { ok: true, channel: "C1", ts: "4" } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, editor } = ctxWith({ editorResult: "x" });
    const { postMessageTool } = await import("../lib/tools/post-message");
    await invokeWithCtx(postMessageTool, { channel: "C1", text: "draft" }, ctx);
    expect(editor).not.toHaveBeenCalled();
    // Draft text is sent as-is (no edit step).
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.text).toBe("draft");
  });

  it("REFUSES to post in headless mode by default", async () => {
    // No UI, no opt-in: the headless guard blocks before any review logic.
    // fetch must never be called.
    const fetchMock = mockFetch({ "chat.postMessage": { ok: true } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, editor } = ctxWith({ hasUI: false, editorResult: "ignored" });
    const { postMessageTool } = await import("../lib/tools/post-message");
    const text = firstText(await invokeWithCtx(postMessageTool, { channel: "C1", text: "draft" }, ctx));
    expect(text).toMatch(/headless/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
  });

  it("PROCEEDS in headless mode when slack-allow-headless-write is ON (sends draft as-is)", async () => {
    // The opt-in: an unsupervised run may post. No editor (no UI); the draft
    // text is sent verbatim.
    setAllowHeadlessWriteEnabled(true);
    const fetchMock = mockFetch({ "chat.postMessage": { ok: true, channel: "C1", ts: "5" } });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, editor } = ctxWith({ hasUI: false, editorResult: "ignored" });
    const { postMessageTool } = await import("../lib/tools/post-message");
    const text = firstText(await invokeWithCtx(postMessageTool, { channel: "C1", text: "draft" }, ctx));
    expect(text).toContain("C1");
    expect(editor).not.toHaveBeenCalled();
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.text).toBe("draft");
  });

  it("reports an auth/scope error hint on invalid_auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: false, error: "invalid_auth" }),
      json: async () => ({ ok: false, error: "invalid_auth" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = ctxWith({ editorResult: "x" });
    const { postMessageTool } = await import("../lib/tools/post-message");
    const text = firstText(await invokeWithCtx(postMessageTool, { channel: "C1", text: "x" }, ctx));
    expect(text).toMatch(/chat:write|token/);
  });

  it("DM resolution failure (missing_scope on conversations.open) names im:write, not chat:write", async () => {
    // Regression: conversations.open needs im:write, and the error must point
    // at the RIGHT scope so a user who already has chat:write isn't misled.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: false, error: "missing_scope" }),
      json: async () => ({ ok: false, error: "missing_scope" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = ctxWith({ editorResult: "hey" });
    const { postMessageTool } = await import("../lib/tools/post-message");
    const text = firstText(await invokeWithCtx(postMessageTool, { to_user: "U9", text: "hey" }, ctx));
    expect(text).toContain("im:write");
    expect(text).not.toMatch(/chat:write is required/);
  });
});
