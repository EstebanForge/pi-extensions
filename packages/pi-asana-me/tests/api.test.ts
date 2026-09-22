import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Each test sets the PAT; isolation ensures cache state from previous tests
// does not leak.
beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "test-token-do-not-leak";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeResponse(body: unknown, opts: { ok?: boolean; status?: number; raw?: string } = {}) {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 200;
  const text = opts.raw ?? JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  } as unknown as Response;
}

describe("callAsana write-body envelope", () => {
  it("POST wraps the body in { data: ... }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ data: { gid: "1", name: "x" } }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callAsana } = await import("../lib/api");
    await callAsana("POST", "/tasks", {
      body: { name: "x", projects: ["999"] },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const parsed = JSON.parse(init.body as string) as { data: Record<string, unknown> };
    expect(parsed).toEqual({
      data: { name: "x", projects: ["999"] },
    });
    // Critical: the envelope MUST be `data`, never the raw body.
    expect(parsed).not.toMatchObject({ name: "x" });
  });

  it("PUT wraps the body in { data: ... }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ data: { gid: "1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { callAsana } = await import("../lib/api");
    await callAsana("PUT", "/tasks/1", { body: { completed: true } });

    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const parsed = JSON.parse(init.body as string) as { data: Record<string, unknown> };
    expect(parsed).toEqual({ data: { completed: true } });
  });

  it("GET sends no body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { callAsana } = await import("../lib/api");
    await callAsana("GET", "/tasks", { query: { project: "1" } });

    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it("Authorization header carries Bearer + the PAT", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const { callAsana } = await import("../lib/api");
    await callAsana("GET", "/users/me");

    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token-do-not-leak");
  });
});

describe("callAsana response unwrapping", () => {
  it("unwraps {data: <object>} to T", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse({ data: { gid: "abc", name: "Task" } }),
      ),
    );
    const { callAsana } = await import("../lib/api");
    const got = await callAsana<{ gid: string; name: string }>("GET", "/tasks/abc");
    expect(got).toEqual({ gid: "abc", name: "Task" });
  });

  it("returns bare arrays / objects as-is (no envelope)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ data: [1, 2, 3] })));
    const { callAsana } = await import("../lib/api");
    const got = await callAsana<number[]>("GET", "/foo");
    expect(got).toEqual([1, 2, 3]);
  });

  it("204 returns undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeResponse(null, { status: 204, raw: "" })),
    );
    const { callAsana } = await import("../lib/api");
    const got = await callAsana<void>("DELETE", "/tasks/1");
    expect(got).toBeUndefined();
  });
});

describe("callAsana error mapping", () => {
  it("401 surfaces a token-message hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse(
          { errors: [{ message: "Not Authorized" }] },
          { ok: false, status: 401, raw: JSON.stringify({ errors: [{ message: "Not Authorized" }] }) },
        ),
      ),
    );
    const { callAsana, AsanaError } = await import("../lib/api");
    await expect(callAsana("GET", "/users/me")).rejects.toThrow(AsanaError);
    await expect(callAsana("GET", "/users/me")).rejects.toThrow(/Not Authorized/);
  });

  it("429 surfaces a rate-limit hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse(
          { errors: [{ message: "rate limit" }] },
          { ok: false, status: 429 },
        ),
      ),
    );
    const { callAsana, AsanaError } = await import("../lib/api");
    await expect(callAsana("GET", "/tasks")).rejects.toThrow(AsanaError);
    try {
      await callAsana("GET", "/tasks");
    } catch (e) {
      expect(e instanceof AsanaError && (e as { isRateLimited: boolean }).isRateLimited).toBe(true);
    }
  });

  it("non-JSON 500 still throws AsanaError with friendly text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse("oops", { ok: false, status: 503, raw: "oops" }),
      ),
    );
    const { callAsana } = await import("../lib/api");
    await expect(callAsana("GET", "/tasks")).rejects.toThrow(/HTTP 503/);
  });
});

describe("callAsana URL building", () => {
  it("appends query params, skipping undefined/null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { callAsana } = await import("../lib/api");
    await callAsana("GET", "/tasks", {
      query: { project: "1", tag: undefined, completed: false },
    });
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl);
    expect(url.pathname).toBe("/api/1.0/tasks");
    expect(url.searchParams.get("project")).toBe("1");
    expect(url.searchParams.get("completed")).toBe("false");
    expect(url.searchParams.has("tag")).toBe(false);
  });

  it("tolerates paths without a leading slash", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { callAsana } = await import("../lib/api");
    await callAsana("GET", "tasks/123", {});
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(new URL(calledUrl).pathname).toBe("/api/1.0/tasks/123");
  });
});

describe("downloadExternalUrl", () => {
  function makeBinary(text: string, contentType = "application/octet-stream") {
    const ab = new TextEncoder().encode(text).buffer as ArrayBuffer;
    const headers = new Headers();
    headers.set("content-type", contentType);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => ab,
      text: async () => text,
      headers,
    } as unknown as Response;
  }

  it("sends NO Authorization header (S3 presigned links reject the token)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeBinary("x", "text/csv"));
    vi.stubGlobal("fetch", fetchMock);
    const { downloadExternalUrl } = await import("../lib/api");
    await downloadExternalUrl("https://s3.example/presigned");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const headers = init.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
    // Belt-and-braces: the init must not carry an Authorization at all.
    expect(init.headers).toBeUndefined();
  });

  it("returns the bytes + content-type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeBinary("hello", "text/csv")));
    const { downloadExternalUrl } = await import("../lib/api");
    const out = await downloadExternalUrl("https://s3.example/x");
    expect(out.contentType).toBe("text/csv");
    expect(new Uint8Array(out.bytes).length).toBe(5);
  });

  it("maps a non-2xx to AsanaError with a refresh hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => "forbidden",
        headers: new Headers(),
      } as unknown as Response),
    );
    const { downloadExternalUrl, AsanaError } = await import("../lib/api");
    await expect(downloadExternalUrl("https://s3.example/x")).rejects.toThrow(AsanaError);
    await expect(downloadExternalUrl("https://s3.example/x")).rejects.toThrow(/HTTP 403/);
  });

  it("refuses an object whose Content-Length exceeds the cap BEFORE buffering", async () => {
    const headers = new Headers();
    headers.set("content-type", "video/mp4");
    // Declare a size past the 100 MB cap.
    headers.set("content-length", String(150 * 1024 * 1024));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // If the code ignored the preflight and buffered, this would OOM. Keep
      // the body tiny; the assertion is that we never call arrayBuffer().
      arrayBuffer: async () => {
        throw new Error("arrayBuffer must not be read when Content-Length exceeds the cap");
      },
      text: async () => "",
      headers,
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { downloadExternalUrl, AsanaError } = await import("../lib/api");
    await expect(downloadExternalUrl("https://s3.example/huge")).rejects.toThrow(AsanaError);
    await expect(downloadExternalUrl("https://s3.example/huge")).rejects.toThrow(/too large/i);
  });

  it("refuses a too-large body when Content-Length is absent", async () => {
    // No content-length header: the post-read byte-length guard must catch it.
    const oversized = new Uint8Array(101 * 1024 * 1024);
    const headers = new Headers();
    headers.set("content-type", "application/octet-stream");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => oversized.buffer as ArrayBuffer,
        text: async () => "",
        headers,
      } as unknown as Response),
    );
    const { downloadExternalUrl, AsanaError } = await import("../lib/api");
    await expect(downloadExternalUrl("https://s3.example/big")).rejects.toThrow(AsanaError);
    await expect(downloadExternalUrl("https://s3.example/big")).rejects.toThrow(/too large/i);
  });

  it("maps a mid-stream abort on arrayBuffer() to the retry hint, not a raw AbortError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        // fetch succeeded but the body read aborted (the realistic failure
        // mode for a slow/large download hitting the timeout).
        arrayBuffer: async () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          throw err;
        },
        text: async () => "",
        headers: new Headers(),
      } as unknown as Response),
    );
    const { downloadExternalUrl, AsanaError } = await import("../lib/api");
    await expect(downloadExternalUrl("https://s3.example/x")).rejects.toThrow(AsanaError);
    // Must surface the retry hint, NOT a raw "operation was aborted" leak.
    await expect(downloadExternalUrl("https://s3.example/x")).rejects.toThrow(/timed out/);
    await expect(downloadExternalUrl("https://s3.example/x")).rejects.toThrow(/retry/i);
  });
});
