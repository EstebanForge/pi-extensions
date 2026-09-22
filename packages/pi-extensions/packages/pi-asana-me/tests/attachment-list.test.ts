import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke, firstText } from "./_helpers";

beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASANA_ACCESS_TOKEN;
});

// Wrap a data array in Asana's { data, next_page } envelope the way the
// paged endpoints return it. null next_page ends pagination.
function mkPage(data: unknown[], nextOffset: string | null = null) {
  const env: { data: unknown[]; next_page?: { offset: string } } = { data };
  if (nextOffset !== null) env.next_page = { offset: nextOffset };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(env),
    json: async () => env,
  } as unknown as Response;
}

async function callList(
  params: { task_gid?: string },
  fetchMock = vi.fn(),
) {
  vi.stubGlobal("fetch", fetchMock);
  const { listAttachmentsTool } = await import("../lib/tools/attachment-list");
  return { text: firstText(await invoke(listAttachmentsTool, params)), fetchMock };
}

describe("asana_list_attachments", () => {
  it("queries /tasks/{gid}/attachments with host+download_url in opt_fields", async () => {
    const { fetchMock } = await callList(
      { task_gid: "t1" },
      vi.fn().mockResolvedValue(mkPage([])),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl);
    expect(url.pathname).toBe("/api/1.0/tasks/t1/attachments");
    const opt = url.searchParams.get("opt_fields") ?? "";
    expect(opt).toContain("host");
    expect(opt).toContain("download_url");
    expect(opt).toContain("name");
    expect(opt).toContain("view_url");
  });

  it("reports no attachments when the task has none", async () => {
    const { text } = await callList(
      { task_gid: "empty" },
      vi.fn().mockResolvedValue(mkPage([])),
    );
    expect(text).toContain("no attachments on task empty");
  });

  it("renders each attachment with gid + a download hint, marking external hosts as non-downloadable", async () => {
    const data = [
      {
        gid: "a1",
        name: "roster.xlsx",
        resource_subtype: "file",
        host: "asana",
        download_url: "https://s3/presigned",
        view_url: "https://view/a1",
        size: 2048,
        created_at: "2026-08-01T10:00:00.000Z",
        created_by: { gid: "u", name: "Esteban" },
      },
      {
        gid: "a2",
        name: "plan.gsheet",
        host: "gdrive",
        download_url: null,
        view_url: "https://drive/plan",
        size: null,
        created_at: "2026-08-02T10:00:00.000Z",
        created_by: { gid: "u", name: "Esteban" },
      },
    ];
    const { text } = await callList(
      { task_gid: "t1" },
      vi.fn().mockResolvedValue(mkPage(data)),
    );
    expect(text).toContain("2 attachments on task t1");
    expect(text).toContain("roster.xlsx (gid: a1)");
    expect(text).toContain("asana-hosted (downloadable)");
    expect(text).toContain("call asana_download_attachment with attachment_gid=a1");
    // External host: flagged as view_url-only, NOT marked downloadable.
    expect(text).toContain("plan.gsheet (gid: a2)");
    expect(text).toContain("external host (gdrive)");
    expect(text).toMatch(/returns a view_url, not a local file/);
  });

  it("paginates via next_page.offset across multiple pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      gid: `g${i}`,
      name: `f${i}`,
      host: "asana",
      download_url: "https://s3",
    }));
    const page2 = [{ gid: "g100", name: "f100", host: "asana", download_url: "https://s3" }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkPage(page1, "tok"))
      .mockResolvedValueOnce(mkPage(page2, null));
    const { text, fetchMock: fm } = await callList({ task_gid: "t" }, fetchMock);
    expect(fm).toHaveBeenCalledTimes(2);
    const [u1] = fm.mock.calls[0] as [string];
    const [u2] = fm.mock.calls[1] as [string];
    expect(new URL(u1).searchParams.has("offset")).toBe(false);
    expect(new URL(u2).searchParams.get("offset")).toBe("tok");
    expect(text).toContain("101 attachments");
    expect(text).toContain("g100");
  });

  it("points back to asana_search_objects on 404", async () => {
    const { text } = await callList(
      { task_gid: "ghost" },
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ errors: [{ message: "not_found" }] }),
        json: async () => ({ errors: [{ message: "not_found" }] }),
      } as unknown as Response),
    );
    expect(text).toContain("task ghost not found");
    expect(text).toContain("asana_search_objects");
  });
});
