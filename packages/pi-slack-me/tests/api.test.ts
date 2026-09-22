import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  process.env.SLACK_USER_TOKEN = "xoxp-test";
});

afterEach(() => {
  delete process.env.SLACK_USER_TOKEN;
  vi.unstubAllGlobals();
});

// Build a fetch mock that returns a given JSON body + status. Slack returns
// 200 with {ok:false} for logical failures, so status alone is not enough.
function mockFetch(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response);
}

describe("slackGet", () => {
  it("sends the bearer token and returns the parsed body on ok", async () => {
    const fetchMock = mockFetch({ ok: true, channels: [{ id: "C1" }] });
    vi.stubGlobal("fetch", fetchMock);
    const { slackGet } = await import("../lib/api");
    const resp = await slackGet<{ channels: { id: string }[] }>("conversations.list");
    expect(resp.channels[0].id).toBe("C1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("conversations.list");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxp-test");
  });

  it("serializes query params, skipping undefined/null", async () => {
    const fetchMock = mockFetch({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { slackGet } = await import("../lib/api");
    await slackGet("conversations.history", {
      query: { channel: "C1", limit: 10, cursor: undefined, x: undefined },
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("channel=C1");
    expect(url).toContain("limit=10");
    expect(url).not.toContain("cursor=");
    expect(url).not.toContain("x=");
  });

  it("maps a logical {ok:false} body to SlackApiError with the code", async () => {
    vi.stubGlobal("fetch", mockFetch({ ok: false, error: "not_in_channel" }));
    const { slackGet, SlackApiError } = await import("../lib/api");
    await expect(slackGet("conversations.history")).rejects.toThrow(SlackApiError);
    try {
      await slackGet("conversations.history");
    } catch (err) {
      expect(err).toBeInstanceOf(SlackApiError);
      expect((err as { code?: string }).code).toBe("not_in_channel");
      expect((err as Error).message).toMatch(/not_in_channel/);
    }
  });

  it("maps auth errors to isAuthError=true", async () => {
    vi.stubGlobal("fetch", mockFetch({ ok: false, error: "invalid_auth" }));
    const { slackGet } = await import("../lib/api");
    try {
      await slackGet("auth.test");
      expect.unreachable("expected throw");
    } catch (err) {
      expect((err as { isAuthError: boolean }).isAuthError).toBe(true);
      expect((err as Error).message).toMatch(/invalid_auth/);
    }
  });

  it("surfaces 429 with retry-after as isRateLimited and the hint", async () => {
    vi.stubGlobal("fetch", mockFetch({ ok: false, error: "ratelimited" }, 429, { "retry-after": "12" }));
    const { slackGet } = await import("../lib/api");
    try {
      await slackGet("search.messages");
      expect.unreachable("expected throw");
    } catch (err) {
      expect((err as { isRateLimited: boolean }).isRateLimited).toBe(true);
      expect((err as { retryAfter?: number }).retryAfter).toBe(12);
      expect((err as Error).message).toMatch(/12s/);
    }
  });

  it("surfaces 5xx with a retry hint", async () => {
    vi.stubGlobal("fetch", mockFetch("upstream down", 503));
    const { slackGet, SlackApiError } = await import("../lib/api");
    await expect(slackGet("auth.test")).rejects.toThrow(SlackApiError);
    try {
      await slackGet("auth.test");
    } catch (err) {
      expect((err as Error).message).toMatch(/HTTP 503/);
    }
  });

  it("aborts on network throw and yields a timeout-shaped error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("The operation was aborted")),
    );
    const { slackGet } = await import("../lib/api");
    await expect(slackGet("auth.test")).rejects.toThrow(/timed out|Network error/);
  });
});

describe("slackDownload", () => {
  it("sends the bearer token and returns the ArrayBuffer", async () => {
    const buf = new ArrayBuffer(4);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => buf } as unknown as Response),
    );
    const { slackDownload } = await import("../lib/api");
    const out = await slackDownload("https://files.slack.com/x");
    expect(out).toBe(buf);
    const [, init] = (vi.mocked(fetch).mock.calls[0] as [string, RequestInit]);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxp-test");
  });

  it("throws SlackApiError on non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response),
    );
    const { slackDownload, SlackApiError } = await import("../lib/api");
    await expect(slackDownload("https://files.slack.com/x")).rejects.toThrow(SlackApiError);
  });
});

describe("slackPost", () => {
  // Capture-aware fetch mock: returns the captured init so tests can assert
  // method, headers, and the JSON body sent on a POST.
  function mockPost(body: unknown, status = 200, headers: Record<string, string> = {}) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("POSTs with bearer auth, JSON content-type, and a JSON-stringified body", async () => {
    const fetchMock = mockPost({ ok: true, channel: "C1", ts: "1" });
    const { slackPost } = await import("../lib/api");
    await slackPost("chat.postMessage", { body: { channel: "C1", text: "hi" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("chat.postMessage");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxp-test");
    expect(headers["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(init.body as string)).toEqual({ channel: "C1", text: "hi" });
  });

  it("does NOT set Content-Type when no body is supplied", async () => {
    const fetchMock = mockPost({ ok: true });
    const { slackPost } = await import("../lib/api");
    await slackPost("chat.delete", { query: { channel: "C1" } });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("serializes query params alongside a POST body", async () => {
    const fetchMock = mockPost({ ok: true });
    const { slackPost } = await import("../lib/api");
    await slackPost("chat.update", { query: { foo: "bar" }, body: { x: 1 } });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("foo=bar");
  });

  it("maps a logical {ok:false} body to a SlackApiError with the code", async () => {
    mockPost({ ok: false, error: "cant_update_message" });
    const { slackPost, SlackApiError } = await import("../lib/api");
    try {
      await slackPost("chat.update", { body: {} });
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SlackApiError);
      expect((err as { code?: string }).code).toBe("cant_update_message");
    }
  });

  it("surfaces 429 through the POST path with retry-after", async () => {
    mockPost({ ok: false, error: "ratelimited" }, 429, { "retry-after": "8" });
    const { slackPost } = await import("../lib/api");
    try {
      await slackPost("chat.postMessage", { body: {} });
      expect.unreachable("expected throw");
    } catch (err) {
      expect((err as { isRateLimited: boolean }).isRateLimited).toBe(true);
      expect((err as { retryAfter?: number }).retryAfter).toBe(8);
    }
  });

  // missing_scope must name the RIGHT scope for the method that failed, not a
  // hardcoded one. This pins requiredScopeFor() through its only consumer
  // (friendlyError) so the DM path (conversations.open -> im:write) cannot
  // regress to telling the user to add chat:write.
  it("missing_scope on chat.* names chat:write (not im:write)", async () => {
    mockPost({ ok: false, error: "missing_scope" });
    const { slackPost } = await import("../lib/api");
    try {
      await slackPost("chat.postMessage", { body: {} });
      expect.unreachable("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain("chat:write");
      expect((err as Error).message).not.toContain("im:write");
    }
  });

  it("missing_scope on conversations.open names im:write (not chat:write)", async () => {
    mockPost({ ok: false, error: "missing_scope" });
    const { slackPost } = await import("../lib/api");
    try {
      await slackPost("conversations.open", { body: {} });
      expect.unreachable("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain("im:write");
      expect((err as Error).message).not.toContain("chat:write");
    }
  });
});
