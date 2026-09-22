import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke, firstText } from "./_helpers";

beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASANA_ACCESS_TOKEN;
});

function makeResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body as unknown,
  } as unknown as Response;
}

async function runSearchTool(
  params: { workspace?: string; query?: string; resource_type?: string; count?: number } = {},
) {
  const fetchMock = vi.fn().mockResolvedValue(
    makeResponse({
      data: [
        { gid: "1", resource_type: "task", name: "First" },
        { gid: "2", resource_type: "task", name: "Second" },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { searchObjectsTool } = await import("../lib/tools/search");
  const result = await invoke(searchObjectsTool, params);
  return { text: firstText(result), fetchMock };
}

describe("asana_search_objects query params", () => {
  it("uses singular resource_type (not resource_types) and count (not limit)", async () => {
    const { fetchMock } = await runSearchTool({ workspace: "111", query: "bug" });
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl);
    expect(url.pathname).toBe("/api/1.0/workspaces/111/typeahead");
    // Critical: singular parameter names. Asana ignores unknown ones silently
    // (returning the default user list) so naming drift here is silent.
    expect(url.searchParams.has("resource_types")).toBe(false);
    expect(url.searchParams.has("limit")).toBe(false);
    expect(url.searchParams.get("resource_type")).toBe("task");
    expect(url.searchParams.get("count")).toBe("20");
    expect(url.searchParams.get("query")).toBe("bug");
  });

  it("defaults resource_type to task when caller omits it", async () => {
    const { fetchMock } = await runSearchTool({ workspace: "111", query: "x" });
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(new URL(calledUrl).searchParams.get("resource_type")).toBe("task");
  });

  it("honours the caller-supplied resource_type", async () => {
    const { fetchMock } = await runSearchTool({
      workspace: "111",
      query: "x",
      resource_type: "project",
    });
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(new URL(calledUrl).searchParams.get("resource_type")).toBe("project");
  });

  it("passes count through", async () => {
    const { fetchMock } = await runSearchTool({ workspace: "111", query: "x", count: 7 });
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(new URL(calledUrl).searchParams.get("count")).toBe("7");
  });

  it("renders results with resource type, name, and gid", async () => {
    const { text } = await runSearchTool({ workspace: "111", query: "bug" });
    expect(text).toContain("[task]");
    expect(text).toContain("First");
    expect(text).toContain("gid: 1");
    expect(text).toContain("Second");
  });

  it("renders an empty message when Asana returns nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse({ data: [] })));
    const { searchObjectsTool } = await import("../lib/tools/search");
    const text = firstText(await invoke(searchObjectsTool, {
      workspace: "111",
      query: "nope",
    }));
    expect(text).toMatch(/No .* matched "nope"/);
  });
});
