import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke, firstText } from "./_helpers";

beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASANA_ACCESS_TOKEN;
});

function makeResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body as unknown,
  } as unknown as Response;
}

async function callGetComment(
  params: Record<string, unknown>,
  fetchMock = vi.fn(),
) {
  vi.stubGlobal("fetch", fetchMock);
  const { getCommentTool } = await import("../lib/tools/comment-get");
  return { text: firstText(await invoke(getCommentTool, params)), fetchMock };
}

describe("asana_get_comment", () => {
  it("returns the full comment text with no truncation", async () => {
    // Well past the 700-char cap in asana_get_task_comments. The whole body
    // must survive intact here.
    const longBody = "x".repeat(3000);
    const { text, fetchMock } = await callGetComment(
      { story_gid: "1216423194210001" },
      vi.fn().mockResolvedValue(
        makeResponse({
          data: {
            gid: "1216423194210001",
            type: "comment",
            resource_subtype: "comment_added",
            text: longBody,
            created_at: "2026-07-09T14:02:22.268Z",
            created_by: { gid: "u1", name: "Esteban" },
          },
        }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(new URL(calledUrl).pathname).toBe("/api/1.0/stories/1216423194210001");

    expect(text).toContain("1216423194210001");
    expect(text).toContain("Esteban");
    expect(text).toContain(longBody);
    expect(text).not.toContain("truncated");
  });

  it("requests the stories/{gid} path (not /tasks) with a text-bearing projection", async () => {
    const { fetchMock } = await callGetComment(
      { story_gid: "42" },
      vi.fn().mockResolvedValue(
        makeResponse({
          data: { gid: "42", type: "comment", text: "hi", created_by: { name: "X" } },
        }),
      ),
    );
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl);
    expect(url.pathname).toBe("/api/1.0/stories/42");
    const optFields = url.searchParams.get("opt_fields") ?? "";
    expect(optFields).toContain("text");
    expect(optFields).toContain("created_at");
  });

  it("renders an empty body line when the comment has no text", async () => {
    const { text } = await callGetComment(
      { story_gid: "7" },
      vi.fn().mockResolvedValue(
        makeResponse({
          data: {
            gid: "7",
            type: "comment",
            text: "",
            created_at: "2026-07-09T14:02:22.268Z",
            created_by: { name: "Nobody" },
          },
        }),
      ),
    );
    expect(text).toContain("Comment 7");
    // The body line is present and empty (no crash, no 'undefined').
    expect(text).not.toContain("undefined");
  });

  it("returns a not-found message on 404 that points back to the listing tool", async () => {
    const { text } = await callGetComment(
      { story_gid: "bogus" },
      vi.fn().mockResolvedValue(
        makeResponse({ errors: [{ message: "not_found" }] }, 404),
      ),
    );
    expect(text).toContain("not found");
    expect(text).toContain("asana_get_task_comments");
  });

  // The code comment in comment-get.ts claims the tool "also works if a
  // caller passes a system story gid (rare, but harmless)" and renders the
  // type in the label. Cover that branch.
  it("renders the type label when the story is not a human comment", async () => {
    const { text } = await callGetComment(
      { story_gid: "sys-1" },
      vi.fn().mockResolvedValue(
        makeResponse({
          data: {
            gid: "sys-1",
            type: "system",
            resource_subtype: "assigned",
            text: "assigned to Esteban",
            created_at: "2026-07-09T14:02:22.268Z",
            created_by: { name: "Asana Bot" },
          },
        }),
      ),
    );
    expect(text).toContain("type=system");
    expect(text).toContain("assigned to Esteban");
    // Must NOT render the bare-comment label (which omits the type suffix).
    expect(text).not.toMatch(/Comment sys-1 \(by Asana Bot at[^,)]+\):/);
  });

  // The recovery tool's whole purpose is "full body no matter what". If
  // Asana returns empty `text` but populates `html_text`, we must fall
  // through to it. The `||` (not `??`) makes that work even when text is "".
  it("falls back to html_text when text is empty, not null", async () => {
    const { text } = await callGetComment(
      { story_gid: "h1" },
      vi.fn().mockResolvedValue(
        makeResponse({
          data: {
            gid: "h1",
            type: "comment",
            text: "",
            html_text: "<body>the real body</body>",
            created_at: "2026-07-09T14:02:22.268Z",
            created_by: { name: "Esteban" },
          },
        }),
      ),
    );
    expect(text).toContain("<body>the real body</body>");
  });
});
