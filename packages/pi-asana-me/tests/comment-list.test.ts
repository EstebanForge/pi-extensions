import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke, firstText } from "./_helpers";

beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASANA_ACCESS_TOKEN;
});

// Mock a single page of /stories. Pass the data array directly; the helper
// wraps it in Asana's { data, next_page } envelope and handles the pagination
// token via the optional nextOffset.
function mkPage(data: unknown[], nextOffset: string | null = null) {
  const envelope: { data: unknown[]; next_page?: { offset: string } } = { data };
  if (nextOffset !== null) envelope.next_page = { offset: nextOffset };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(envelope),
    json: async () => envelope,
  } as unknown as Response;
}

async function callComments(
  params: { task_gid?: string; limit?: number } = {},
  fetchMock = vi.fn(),
) {
  vi.stubGlobal("fetch", fetchMock);
  const { getTaskCommentsTool } = await import("../lib/tools/comment-list");
  return { text: firstText(await invoke(getTaskCommentsTool, params)), fetchMock };
}

describe("asana_get_task_comments", () => {
  it("queries /tasks/{gid}/stories (the stories endpoint, not /tasks)", async () => {
    const { fetchMock } = await callComments(
      { task_gid: "abc" },
      vi.fn().mockResolvedValue(mkPage([])),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(new URL(calledUrl).pathname).toBe("/api/1.0/tasks/abc/stories");
  });

  it("requests `type` so the discriminator can be evaluated client-side", async () => {
    const { fetchMock } = await callComments(
      { task_gid: "abc" },
      vi.fn().mockResolvedValue(mkPage([])),
    );
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const optFields = new URL(calledUrl).searchParams.get("opt_fields") ?? "";
    expect(optFields).toContain("type");
    expect(optFields).toContain("created_at");
  });

  it("filters on `type === \"comment\"` (NOT `resource_subtype`)", async () => {
    const data = [
      {
        gid: "s-comment-1",
        type: "comment",
        resource_subtype: "comment_added",
        text: "Sarah's review thread",
        created_at: "2026-07-01T00:00:00.000Z",
        created_by: { gid: "u1", name: "Sarah MacLean" },
      },
      {
        gid: "s-system-1",
        type: "system",
        resource_subtype: "marked_incomplete",
        text: "marked this task as incomplete",
      },
      {
        gid: "s-comment-2",
        type: "comment",
        resource_subtype: "comment_added",
        text: "Esteban: blockers updated",
        created_at: "2026-07-02T00:00:00.000Z",
        created_by: { gid: "u2", name: "Esteban" },
      },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mkPage(data)));
    const { getTaskCommentsTool } = await import("../lib/tools/comment-list");
    const text = firstText(await invoke(getTaskCommentsTool, { task_gid: "t" }));
    expect(text).toContain("2 of 2 comments");
    expect(text).toContain("Sarah MacLean");
    expect(text).toContain("Esteban");
    expect(text).not.toContain("marked_incomplete");
  });

  // The previous live-tested bug. Without client-side sort, the tool
  // silently returned oldest-first when Asana does.
  it("sorts comments newest-first regardless of Asana's return order", async () => {
    const data = [
      {
        gid: "old-1",
        type: "comment",
        text: "oldest comment",
        created_at: "2025-11-21T15:36:49.229Z",
        created_by: { gid: "u1", name: "Adrian" },
      },
      {
        gid: "old-2",
        type: "comment",
        text: "middle comment",
        created_at: "2025-11-24T20:39:49.937Z",
        created_by: { gid: "u1", name: "Adrian" },
      },
      {
        gid: "latest",
        type: "comment",
        text: "NEWEST comment",
        created_at: "2026-06-15T12:00:00.000Z",
        created_by: { gid: "u3", name: "Teni" },
      },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mkPage(data)));
    const { getTaskCommentsTool } = await import("../lib/tools/comment-list");
    const text = firstText(
      await invoke(getTaskCommentsTool, { task_gid: "t", limit: 2 }),
    );
    expect(text).toContain("2 of 3 comments");
    expect(text).toContain("NEWEST comment");
    expect(text).toContain("Teni");
    expect(text).toContain("middle comment");
    expect(text).toContain("(1 older comment not shown");
    expect(text).not.toContain("oldest comment");
  });

  // The most recent live bug: a task with >100 stories had a comment
  // newer than the ones surfaced in page 1. Pagination reaches it on
  // page 2. We use synthesized GIDs here — never pin a live Asana
  // resource GID in a test.
  it("paginates through next_page until the server says there is no more", async () => {
    const PAGE2_COMMENT_GID = "0000000000000002";

    // Page 1: many system events + 1 "old" comment.
    const page1Data: unknown[] = [];
    for (let i = 0; i < 50; i++) {
      page1Data.push({
        gid: `sys-${i}`,
        type: "system",
        text: "system event",
      });
    }
    page1Data.push({
      gid: "0000000000000003",
      type: "comment",
      text: "old comment from page 1",
      created_at: "2025-11-21T15:36:49.229Z",
      created_by: { gid: "u1", name: "Adrian" },
    });

    // Page 2: the user's pointed-at comment lives here, past row 100.
    const page2Data = [
      {
        gid: PAGE2_COMMENT_GID,
        type: "comment",
        text: "new comment on page 2",
        created_at: "2026-06-15T12:00:00.000Z",
        created_by: { gid: "u3", name: "Teni" },
      },
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkPage(page1Data, "page-2-token"))
      .mockResolvedValueOnce(mkPage(page2Data, null));
    vi.stubGlobal("fetch", fetchMock);

    const { getTaskCommentsTool } = await import("../lib/tools/comment-list");
    const text = firstText(await invoke(getTaskCommentsTool, { task_gid: "t", limit: 5 }));

    // Two fetch calls: page 1 (with next token) + page 2 (terminating).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1] = fetchMock.mock.calls[0] as [string];
    const [url2] = fetchMock.mock.calls[1] as [string];
    expect(new URL(url1).searchParams.has("offset")).toBe(false);
    expect(new URL(url2).searchParams.get("offset")).toBe("page-2-token");

    // Both pages' comments are accounted for; the page-2 comment surfaces.
    expect(text).toContain(PAGE2_COMMENT_GID);
    expect(text).toContain("new comment on page 2");
    expect(text).toContain("Teni");
    expect(text).toContain("2 of 2 comments");
  });

  it("uses offset query param on subsequent pages, not on the first", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkPage([], "page-2-token"))
      .mockResolvedValueOnce(mkPage([]));
    vi.stubGlobal("fetch", fetchMock);

    const { getTaskCommentsTool } = await import("../lib/tools/comment-list");
    await invoke(getTaskCommentsTool, { task_gid: "t" });

    const [url1] = fetchMock.mock.calls[0] as [string];
    const [url2] = fetchMock.mock.calls[1] as [string];
    expect(new URL(url1).searchParams.has("offset")).toBe(false);
    expect(new URL(url2).searchParams.get("offset")).toBe("page-2-token");
  });

  it("surfaces the hit-cap footer when the local MAX_PAGES ceiling is reached", async () => {
    // Always returns a next_page so the loop runs MAX_PAGES times. Each
    // page contains one comment so the render path runs (the footer only
    // fires when there are comments to display).
    // Use limit well above the expected count so `remaining === 0` and the
    // hit-cap footer is the one rendered (not the "older comments" footer).
    const page = [
      {
        gid: "c1",
        type: "comment" as const,
        text: "kept short",
        created_at: "2026-07-01T00:00:00.000Z",
        created_by: { gid: "u", name: "User" },
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(mkPage(page, "next-token"));
    vi.stubGlobal("fetch", fetchMock);

    const { getTaskCommentsTool } = await import("../lib/tools/comment-list");
    const text = firstText(
      await invoke(getTaskCommentsTool, { task_gid: "t", limit: 100 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(text).toContain("Hit the local pagination cap");
  });

  it("respects the limit parameter (default 5)", async () => {
    const stories = Array.from({ length: 8 }, (_, i) => ({
      gid: `c${i}`,
      type: "comment" as const,
      resource_subtype: "comment_added",
      text: `comment ${i}`,
      created_at: new Date(2026, 0, 1 + i).toISOString(),
      created_by: { gid: "u", name: "User" },
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mkPage(stories)));
    const { getTaskCommentsTool } = await import("../lib/tools/comment-list");
    const text = firstText(
      await invoke(getTaskCommentsTool, { task_gid: "abc", limit: 3 }),
    );
    expect(text).toContain("3 of 8 comments");
    expect(text).toMatch(/5 older comment/);
  });

  it("puts comments with missing created_at at the END of the list", async () => {
    const data = [
      {
        gid: "no-date",
        type: "comment",
        text: "no timestamp",
        created_by: { gid: "u", name: "Mystery" },
      },
      {
        gid: "dated",
        type: "comment",
        text: "dated",
        created_at: "2026-07-01T00:00:00.000Z",
        created_by: { gid: "u", name: "Dated" },
      },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mkPage(data)));
    const { getTaskCommentsTool } = await import("../lib/tools/comment-list");
    const text = firstText(
      await invoke(getTaskCommentsTool, { task_gid: "abc", limit: 1 }),
    );
    expect(text).toContain("Dated");
    expect(text).not.toContain("Mystery");
  });

  it("truncates comments longer than 700 chars with a hint to fetch by GID", async () => {
    const data = [
      {
        gid: "long",
        type: "comment" as const,
        text: "x".repeat(2000),
        created_at: "2026-07-01T00:00:00.000Z",
        created_by: { gid: "u", name: "User" },
      },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mkPage(data)));
    const { getTaskCommentsTool } = await import("../lib/tools/comment-list");
    const text = firstText(await invoke(getTaskCommentsTool, { task_gid: "abc" }));
    expect(text).toContain("truncated at 700 chars");
    expect(text).toContain("call asana_get_comment with story_gid=long");
    expect(text.length).toBeLessThan(2000 + 500);
  });

  it("renders the system-stories-exist hint when only system stories are returned", async () => {
    const data = [
      { gid: "ss1", type: "system", text: "marked today" },
      { gid: "ss2", type: "system", text: "assigned to X" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mkPage(data)));
    const { getTaskCommentsTool } = await import("../lib/tools/comment-list");
    const text = firstText(await invoke(getTaskCommentsTool, { task_gid: "abc" }));
    expect(text).toContain("no comments on task abc");
    expect(text).toContain("2 system story/stories");
  });
});
