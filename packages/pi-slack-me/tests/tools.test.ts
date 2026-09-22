import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke, firstText } from "./_helpers";

beforeEach(async () => {
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  // Fresh modules so the in-process user-name cache (lib/users.ts) does not
  // leak resolved names across tests within this file.
  vi.resetModules();
});

afterEach(() => {
  delete process.env.SLACK_USER_TOKEN;
  vi.unstubAllGlobals();
});

function mockFetch(routes: Record<string, unknown>, status = 200) {
  return vi.fn().mockImplementation((url: string) => {
    const u = new URL(url);
    const method = u.pathname.replace("/api/", "");
    const body = routes[method];
    if (!body) throw new Error(`unexpected Slack call: ${method}`);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response);
  });
}

describe("slack_list_channels", () => {
  it("lists conversations from users.conversations and renders DM/channel markers", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "users.conversations": {
          ok: true,
          channels: [
            { id: "C1", name: "general", is_channel: true, num_members: 42, topic: { value: "announcements" } },
            { id: "G2", name: "secret", is_group: true, is_private: true },
            { id: "D3", is_im: true, user: "U9" },
          ],
        },
      }),
    );
    const { listChannelsTool } = await import("../lib/tools/list-channels");
    const text = firstText(await invoke(listChannelsTool, {}));
    expect(text).toContain("**general** (C1)");
    expect(text).toContain("42 members");
    expect(text).toContain("secret");
    expect(text).toContain("DM with U9");
  });

  it("defaults types to include im/mpim", async () => {
    const fetchMock = mockFetch({ "users.conversations": { ok: true, channels: [] } });
    vi.stubGlobal("fetch", fetchMock);
    const { listChannelsTool } = await import("../lib/tools/list-channels");
    await invoke(listChannelsTool, {});
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("types=public_channel");
    expect(url).toContain("im");
    expect(url).toContain("mpim");
  });
});

describe("slack_read_messages", () => {
  it("reads history and resolves user IDs to names", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "conversations.history": {
          ok: true,
          messages: [
            { user: "U1", text: "deploy broke", ts: "1512085950.000216", reply_count: 3 },
          ],
          has_more: true,
        },
        "users.info": { ok: true, user: { id: "U1", profile: { display_name: "Esteban" } } },
      }),
    );
    const { readMessagesTool } = await import("../lib/tools/read-messages");
    const text = firstText(await invoke(readMessagesTool, { channel: "C1" }));
    expect(text).toContain("Esteban");
    expect(text).toContain("deploy broke");
    expect(text).toContain("[3 replies]");
    expect(text).toContain("more available");
  });

  it("falls back to the raw ID when users.info fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "conversations.history": { ok: true, messages: [{ user: "UGONE", text: "hi", ts: "1512085950.000216" }] },
        "users.info": { ok: false, error: "user_not_found" },
      }),
    );
    const { readMessagesTool } = await import("../lib/tools/read-messages");
    const text = firstText(await invoke(readMessagesTool, { channel: "C1" }));
    expect(text).toContain("UGONE");
    expect(text).toContain("hi");
  });

  it("includes the message at oldest/latest boundary (inclusive=true)", async () => {
    const fetchMock = mockFetch({
      "conversations.history": {
        ok: true,
        messages: [
          { user: "U1", text: "permalink target", ts: "1783521062.438029" },
        ],
      },
      "users.info": { ok: true, user: { id: "U1", profile: { display_name: "Jeff" } } },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { readMessagesTool } = await import("../lib/tools/read-messages");
    const text = firstText(
      await invoke(readMessagesTool, { channel: "C04C38RJU7R", oldest: "1783521062.438029", limit: 1 }),
    );
    // Regression: Slack defaults oldest/latest to EXCLUSIVE, so the message at
    // the boundary ts would be dropped. We now send inclusive=true whenever a
    // bound is present, so the message must appear.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("inclusive=true");
    expect(url).toContain("oldest=1783521062.438029");
    expect(text).toContain("permalink target");
    expect(text).toContain("Jeff");
  });

  it("does not send inclusive when no oldest/latest is set", async () => {
    const fetchMock = mockFetch({ "conversations.history": { ok: true, messages: [] } });
    vi.stubGlobal("fetch", fetchMock);
    const { readMessagesTool } = await import("../lib/tools/read-messages");
    await invoke(readMessagesTool, { channel: "C1" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain("inclusive=");
  });

  it("reports empty when no messages", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ "conversations.history": { ok: true, messages: [] } }),
    );
    const { readMessagesTool } = await import("../lib/tools/read-messages");
    const text = firstText(await invoke(readMessagesTool, { channel: "C1" }));
    expect(text).toMatch(/no messages/);
  });
});

describe("slack_read_thread", () => {
  it("reads replies passing ts as the parent", async () => {
    const fetchMock = mockFetch({
      "conversations.replies": {
        ok: true,
        messages: [
          { user: "U1", text: "parent", ts: "100.0001" },
          { user: "U2", text: "reply", ts: "100.0002" },
        ],
      },
      "users.info": { ok: true, user: { id: "X", name: "Someone" } },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { readThreadTool } = await import("../lib/tools/read-thread");
    const text = firstText(
      await invoke(readThreadTool, { channel: "C1", thread_ts: "100.0001" }),
    );
    expect(text).toContain("parent");
    expect(text).toContain("reply");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("ts=100.0001");
  });
});

describe("slack_search", () => {
  it("formats matches with permalink and channel", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "search.messages": {
          ok: true,
          messages: {
            matches: [
              {
                iid: "i1",
                ts: "1512085950.000216",
                user: "U1",
                text: "prod is down",
                channel: { id: "C9", name: "ops" },
                permalink: "https://x.slack.com/p/1",
              },
            ],
            total: 1,
          },
        },
        "users.info": { ok: true, user: { id: "U1", name: "oncall" } },
      }),
    );
    const { searchTool } = await import("../lib/tools/search");
    const text = firstText(await invoke(searchTool, { query: "prod down" }));
    expect(text).toContain("1 of 1 total");
    expect(text).toContain("oncall");
    expect(text).toContain("#ops");
    expect(text).toContain("https://x.slack.com/p/1");
  });

  it("reports empty when no matches", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ "search.messages": { ok: true, messages: { matches: [], total: 0 } } }),
    );
    const { searchTool } = await import("../lib/tools/search");
    const text = firstText(await invoke(searchTool, { query: "nothing" }));
    expect(text).toMatch(/No results/);
  });
});

describe("slack_download_file", () => {
  it("downloads url_private_download to a temp path and renders a hint for images", async () => {
    const buf = Buffer.from("img-bytes");
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("files.info")) {
        const body = {
          ok: true,
          file: {
            id: "F1",
            name: "screenshot.png",
            filetype: "png",
            mimetype: "image/png",
            size: 9,
            url_private_download: "https://files.slack.com/dl/F1",
            permalink: "https://x.slack.com/files/F1",
          },
        };
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(body),
          json: async () => body,
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { downloadFileTool } = await import("../lib/tools/download-file");
    const text = firstText(await invoke(downloadFileTool, { file_id: "F1" }));
    expect(text).toContain("screenshot.png");
    expect(text).toContain("image/png");
    expect(text).toContain("read");
    expect(text).toMatch(/pi-slack-me/);
  });

  it("errors cleanly when file has no download URL", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "files.info": { ok: true, file: { id: "F2", name: "gone" } },
      }),
    );
    const { downloadFileTool } = await import("../lib/tools/download-file");
    const text = firstText(await invoke(downloadFileTool, { file_id: "F2" }));
    expect(text).toMatch(/no downloadable URL/);
  });
});

describe("auth gate (all tools)", () => {
  it("every tool returns a SlackAuthError-shaped message when the token is missing", async () => {
    delete process.env.SLACK_USER_TOKEN;
    const { listChannelsTool } = await import("../lib/tools/list-channels");
    const { readMessagesTool } = await import("../lib/tools/read-messages");
    const text = firstText(await invoke(listChannelsTool, {}));
    expect(text).toMatch(/SLACK_USER_TOKEN/);
    const text2 = firstText(await invoke(readMessagesTool, { channel: "C1" }));
    expect(text2).toMatch(/SLACK_USER_TOKEN/);
  });
});
