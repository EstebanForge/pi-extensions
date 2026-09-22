import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke, firstText } from "./_helpers";

beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASANA_ACCESS_TOKEN;
});

function storyGetResponse(
  gid: string,
  opts: { isEditable?: boolean; type?: string; author?: string } = {},
) {
  const data = {
    gid,
    text: "old body",
    is_editable: opts.isEditable ?? true,
    type: opts.type ?? "comment",
    created_at: "2026-07-29T14:44:49.151Z",
    created_by: { gid: "1", name: opts.author ?? "Me" },
  };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data }),
    json: async () => ({ data }),
  } as unknown as Response;
}

function storyPutResponse(gid: string) {
  const data = {
    gid,
    text: "new body",
    resource_type: "story",
    created_at: "2026-07-29T14:44:49.151Z",
  };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data }),
    json: async () => ({ data }),
  } as unknown as Response;
}

describe("asana_update_comment success", () => {
  it("GETs the story, PUTs the replacement text, and reports the edit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(storyGetResponse("999"))
      .mockResolvedValueOnce(storyPutResponse("999"));
    vi.stubGlobal("fetch", fetchMock);

    const { updateCommentTool } = await import("../lib/tools/comment-update");
    const text = firstText(
      await invoke(updateCommentTool, {
        story_gid: "999",
        text: "new body",
      }),
    );

    expect(text).toContain("comment 999 updated");
    // Second call is the PUT; body carries the plain text.
    const putBody = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    expect(putBody).toEqual({ data: { text: "new body" } });
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("PUT");
  });

  it("uses the edited text from the review dialog", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(storyGetResponse("999"))
      .mockResolvedValueOnce(storyPutResponse("999"));
    vi.stubGlobal("fetch", fetchMock);

    const editor = vi.fn().mockResolvedValue("human-edited body");
    const ctx = { hasUI: true, ui: { confirm: vi.fn(), editor } } as unknown;

    const { updateCommentTool } = await import("../lib/tools/comment-update");
    const result = await invoke(
      updateCommentTool,
      { story_gid: "999", text: "agent draft" },
      ctx,
    );

    const putBody = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    expect(putBody).toEqual({ data: { text: "human-edited body" } });
    expect(firstText(result)).toContain("Edited by user: yes");
    expect(result.details).toMatchObject({
      postedContent: "human-edited body",
      edited: true,
    });
  });

  it("sends html_text when html=true and validation passes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(storyGetResponse("999"))
      .mockResolvedValueOnce(storyPutResponse("999"));
    vi.stubGlobal("fetch", fetchMock);

    const { updateCommentTool } = await import("../lib/tools/comment-update");
    await invoke(updateCommentTool, {
      story_gid: "999",
      html: true,
      text: "<body><strong>fixed</strong></body>",
    });

    const putBody = fetchMock.mock.calls[1][1].body as string;
    expect(putBody).toContain('"html_text"');
  });
});

describe("asana_update_comment refusals", () => {
  it("refuses a non-editable story (someone else's comment) without a PUT", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        storyGetResponse("999", { isEditable: false, author: "Alice" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { updateCommentTool } = await import("../lib/tools/comment-update");
    const text = firstText(
      await invoke(updateCommentTool, { story_gid: "999", text: "x" }),
    );

    expect(text).toContain("not editable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a system story without a PUT", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        storyGetResponse("999", { isEditable: false, type: "system" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { updateCommentTool } = await import("../lib/tools/comment-update");
    const text = firstText(
      await invoke(updateCommentTool, { story_gid: "999", text: "x" }),
    );

    expect(text).toContain("system story");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses malformed html_text before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { updateCommentTool } = await import("../lib/tools/comment-update");
    const text = firstText(
      await invoke(updateCommentTool, {
        story_gid: "999",
        html: true,
        text: "<body>one<br>two</body>",
      }),
    );

    expect(text).toContain("refused to edit");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a missing story to a friendly 404 message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ errors: [{ message: "story: Not Found" }] }),
      json: async () => ({}),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const { updateCommentTool } = await import("../lib/tools/comment-update");
    const text = firstText(
      await invoke(updateCommentTool, { story_gid: "404", text: "x" }),
    );

    expect(text).toContain("not found");
  });

  it("reports nothing-changed when the user cancels the review dialog", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(storyGetResponse("999"));
    vi.stubGlobal("fetch", fetchMock);

    const editor = vi.fn().mockResolvedValue(undefined);
    const ctx = { hasUI: true, ui: { confirm: vi.fn(), editor } } as unknown;

    const { updateCommentTool } = await import("../lib/tools/comment-update");
    const text = firstText(
      await invoke(updateCommentTool, { story_gid: "999", text: "x" }, ctx),
    );

    expect(text).toContain("cancelled by user");
    expect(fetchMock).toHaveBeenCalledTimes(1); // GET only, no PUT
  });

  it("proceeds when is_editable is omitted from the response (undefined = editable)", async () => {
    const data = {
      gid: "999",
      text: "old body",
      type: "comment",
      created_at: "2026-07-29T14:44:49.151Z",
      created_by: { gid: "1", name: "Me" },
      // is_editable deliberately absent
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data }),
        json: async () => ({ data }),
      } as unknown as Response)
      .mockResolvedValueOnce(storyPutResponse("999"));
    vi.stubGlobal("fetch", fetchMock);

    const { updateCommentTool } = await import("../lib/tools/comment-update");
    const text = firstText(
      await invoke(updateCommentTool, { story_gid: "999", text: "new body" }),
    );

    expect(text).toContain("comment 999 updated");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("asana_update_comment PUT-time failures", () => {
  function errorResponse(status: number, message: string) {
    return {
      ok: false,
      status,
      text: async () => JSON.stringify({ errors: [{ message }] }),
      json: async () => ({}),
    } as unknown as Response;
  }

  it("surfaces the upstream message on a PUT-time 400", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(storyGetResponse("999"))
      .mockResolvedValueOnce(errorResponse(400, "comment: The comment body is invalid"));
    vi.stubGlobal("fetch", fetchMock);

    const { updateCommentTool } = await import("../lib/tools/comment-update");
    const text = firstText(
      await invoke(updateCommentTool, { story_gid: "999", text: "x" }),
    );

    expect(text).toContain("could not be edited (HTTP 400)");
    expect(text).toContain("The comment body is invalid");
  });

  it("surfaces the upstream message on a PUT-time 403", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(storyGetResponse("999"))
      .mockResolvedValueOnce(errorResponse(403, "not authorized to update story"));
    vi.stubGlobal("fetch", fetchMock);

    const { updateCommentTool } = await import("../lib/tools/comment-update");
    const text = firstText(
      await invoke(updateCommentTool, { story_gid: "999", text: "x" }),
    );

    expect(text).toContain("could not be edited (HTTP 403)");
    expect(text).toContain("asana_add_comment");
  });
});
