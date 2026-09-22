import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeWithCtx, firstText } from "./_helpers";

// Image-attachment tests for slack_post_message. The upload flow is
// URL-routed, not method-routed: two calls hit /api/<method> and one hits the
// presigned upload URL (files.slack.com/upload/...). The mock routes on the
// full URL so all three shapes are distinguishable.

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-slack-img-"));
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.SLACK_USER_TOKEN;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function writePng(name: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return path;
}

// Slack-side mocks: getUploadURLExternal + completeUploadExternal are JSON Web
// API calls; the byte upload is a bare HTTP status (no ok-wrapper).
function apiJsonHandler(body: unknown) {
  return (url: string) => {
    if (url.includes("/api/")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as unknown as Response;
    }
    return undefined;
  };
}

function uploadBytesHandler(status: number, bodyText = "") {
  return (url: string) => {
    if (url.includes("/upload/")) {
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        text: async () => bodyText,
        json: async () => ({}),
      } as unknown as Response;
    }
    return undefined;
  };
}

function mockFetch(handlers: Array<(url: string, init?: RequestInit) => Response | undefined>) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    for (const handler of handlers) {
      const result = handler(url, init);
      if (result) return Promise.resolve(result);
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function ctxWith() {
  const editor = vi.fn().mockResolvedValue("final text");
  return { ctx: { hasUI: true, ui: { confirm: vi.fn(), editor } }, editor };
}

async function runTool(params: Record<string, unknown>): Promise<string> {
  const { ctx } = ctxWith();
  const { postMessageTool } = await import("../lib/tools/post-message");
  return firstText(await invokeWithCtx(postMessageTool, params, ctx));
}

describe("slack_post_message images", () => {
  it("refuses unsupported file types before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const text = await runTool({ channel: "C1", text: "hi", images: [join(tmpDir, "notes.txt")] });
    expect(text).toMatch(/unsupported type/i);
    expect(text).toMatch(/png/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses missing files before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const text = await runTool({ channel: "C1", text: "hi", images: [join(tmpDir, "gone.png")] });
    expect(text).toMatch(/file not found/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads bytes then posts ONE file-share message (no chat.postMessage)", async () => {
    const png = writePng("shot.png");
    const fetchMock = mockFetch([
      apiJsonHandler({
        ok: true,
        upload_url: "https://files.slack.com/upload/v1/ABC",
        file_id: "F123",
      }),
      uploadBytesHandler(200),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const text = await runTool({ channel: "C1", text: "final text", images: [png] });

    expect(text).toMatch(/message with 1 image\(s\) sent to C1/);
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const urlCall = calls.find(([u]) => u.includes("files.getUploadURLExternal"));
    // The upload-ticket methods are form-encoded (they reject JSON bodies).
    const urlBody = new URLSearchParams(urlCall![1].body as string);
    expect(urlBody.get("filename")).toBe("shot.png");
    expect(urlBody.get("length")).toBe("8");
    expect(urlCall![1].headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    const byteCall = calls.find(([u]) => u.includes("/upload/"));
    expect(byteCall![1].headers).toEqual({ "Content-Type": "image/png" });
    const completeCall = calls.find(([u]) => u.includes("files.completeUploadExternal"));
    const completeBody = new URLSearchParams(completeCall![1].body as string);
    expect(completeBody.get("channel_id")).toBe("C1");
    expect(completeBody.get("initial_comment")).toBe("final text");
    expect(JSON.parse(completeBody.get("files")!)).toEqual([
      { id: "F123", title: "shot.png" },
    ]);
    // The whole point of the upload flow: chat.postMessage must never run,
    // or the message would exist twice.
    expect(calls.some(([u]) => u.includes("chat.postMessage"))).toBe(false);
  });

  it("passes thread_ts through to completeUploadExternal", async () => {
    const png = writePng("shot.png");
    let completeBody: URLSearchParams | undefined;
    // The complete-capturing handler MUST come first: apiJsonHandler answers
    // every /api/ URL and would swallow it.
    const fetchMock = mockFetch([
      (url, init) => {
        if (url.includes("files.completeUploadExternal")) {
          completeBody = new URLSearchParams(init!.body as string);
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => "{}",
            json: async () => ({ ok: true }),
          } as unknown as Response;
        }
        return undefined;
      },
      apiJsonHandler({
        ok: true,
        upload_url: "https://files.slack.com/upload/v1/ABC",
        file_id: "F1",
      }),
      uploadBytesHandler(200),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const text = await runTool({
      channel: "C1",
      text: "final text",
      thread_ts: "100.0001",
      images: [png],
    });
    expect(text).toMatch(/threaded reply with 1 image\(s\)/);
    expect(completeBody?.get("thread_ts")).toBe("100.0001");
  });

  it("uploads every image then completes the batch with all file ids", async () => {
    writePng("one.png");
    writePng("two.png");
    let urlCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("files.getUploadURLExternal")) {
        urlCalls += 1;
        const body = {
          ok: true,
          upload_url: `https://files.slack.com/upload/v1/${urlCalls}`,
          file_id: `F${urlCalls}`,
        };
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify(body),
          json: async () => body,
        } as unknown as Response);
      }
      if (url.includes("/upload/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => "",
          json: async () => ({}),
        } as unknown as Response);
      }
      if (url.includes("files.completeUploadExternal")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ ok: true }),
          json: async () => ({ ok: true }),
        } as unknown as Response);
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await runTool({
      channel: "C1",
      text: "final text",
      images: [join(tmpDir, "one.png"), join(tmpDir, "two.png")],
    });
    expect(text).toMatch(/2 image\(s\)/);
    expect(urlCalls).toBe(2);
    const completeCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([u]) =>
      u.includes("files.completeUploadExternal"),
    )!;
    const completeBody = new URLSearchParams(completeCall[1].body as string);
    expect(JSON.parse(completeBody.get("files")!)).toEqual([
      { id: "F1", title: "one.png" },
      { id: "F2", title: "two.png" },
    ]);
  });

  it("fails before completeUploadExternal when the byte upload is rejected (nothing sent)", async () => {
    const png = writePng("big.png");
    const fetchMock = mockFetch([
      apiJsonHandler({
        ok: true,
        upload_url: "https://files.slack.com/upload/v1/ABC",
        file_id: "F123",
      }),
      uploadBytesHandler(413, "too large"),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const text = await runTool({ channel: "C1", text: "final text", images: [png] });
    expect(text).toMatch(/upload failed \(HTTP 413\)/);
    expect(text).toMatch(/too large/);
    const calls = fetchMock.mock.calls as Array<[string]>;
    expect(calls.some(([u]) => u.includes("files.completeUploadExternal"))).toBe(false);
    expect(calls.some(([u]) => u.includes("chat.postMessage"))).toBe(false);
  });

  it("names files:write on missing_scope from the upload flow", async () => {
    const png = writePng("shot.png");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: false, error: "missing_scope" }),
      json: async () => ({ ok: false, error: "missing_scope" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const text = await runTool({ channel: "C1", text: "final text", images: [png] });
    expect(text).toMatch(/files:write/);
  });

  it("surfaces an upload URL-less response as a clean error", async () => {
    const png = writePng("shot.png");
    const fetchMock = mockFetch([apiJsonHandler({ ok: true })]);
    vi.stubGlobal("fetch", fetchMock);
    const text = await runTool({ channel: "C1", text: "final text", images: [png] });
    expect(text).toMatch(/no upload URL for shot\.png/);
    expect(text).toMatch(/Nothing was sent/);
  });
});
