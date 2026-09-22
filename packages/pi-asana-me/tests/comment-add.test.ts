import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke, firstText } from "./_helpers";

beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASANA_ACCESS_TOKEN;
});

function storyResponse(gid: string, createdAt: string) {
  return {
    ok: true,
    status: 201,
    text: async () =>
      JSON.stringify({
        data: { gid, text: "hi", resource_type: "story", created_at: createdAt },
      }),
    json: async () => ({
      data: { gid, text: "hi", resource_type: "story", created_at: createdAt },
    }),
  } as unknown as Response;
}

function taskResponse(gid: string, permalink?: string) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        data: { gid, name: "Some Task", permalink_url: permalink ?? null },
      }),
    json: async () => ({
      data: { gid, name: "Some Task", permalink_url: permalink ?? null },
    }),
  } as unknown as Response;
}

describe("asana_add_comment success summary", () => {
  it("includes the task permalink URL after a successful post", async () => {
    // Default NO_UI ctx: confirm gate short-circuits to "proceed" (headless),
    // so resolveTasks is NOT called up front; it fires once after the POST.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(storyResponse("999", "2026-07-29T14:44:49.151Z"))
      .mockResolvedValueOnce(
        taskResponse(
          "1216960660986098",
          "https://app.asana.com/0/1/1216960660986098",
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { addCommentTool } = await import("../lib/tools/comment-add");
    const result = await invoke(addCommentTool, {
      task_gid: "1216960660986098",
      text: "Deploy confirmed.",
    });
    const text = firstText(result);

    expect(text).toContain("story gid: 999");
    expect(text).toContain("URL: https://app.asana.com/0/1/1216960660986098");
    // Headless fast path -> not edited -> the draft is NOT re-echoed (the
    // agent already has it in context). No block, no details.
    expect(text).not.toContain("Edited by user");
    expect(text).not.toContain("Final content sent");
    expect(result.details).toBeUndefined();
  });

  it("omits the URL gracefully when the task has no permalink_url", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(storyResponse("999", "2026-07-29T14:44:49.151Z"))
      .mockResolvedValueOnce(taskResponse("1216960660986098"));
    vi.stubGlobal("fetch", fetchMock);

    const { addCommentTool } = await import("../lib/tools/comment-add");
    const text = firstText(
      await invoke(addCommentTool, {
        task_gid: "1216960660986098",
        text: "Deploy confirmed.",
      }),
    );

    expect(text).toContain("story gid: 999");
    expect(text).not.toContain("URL:");
  });

  it("echoes the edited text and edited=yes when the user changes the draft", async () => {
    // Interactive UI ctx: the gate resolves the task up front (GET), opens the
    // editor, then POSTs. Give the task a permalink so the post-POST resolve
    // is skipped (keeps this to two fetches).
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        taskResponse("1216960660986098", "https://app.asana.com/0/1/1216960660986098"),
      )
      .mockResolvedValueOnce(storyResponse("555", "2026-07-29T14:44:49.151Z"));
    vi.stubGlobal("fetch", fetchMock);

    const editor = vi.fn().mockResolvedValue("edited body");
    const ctx = { hasUI: true, ui: { confirm: vi.fn(), editor } } as unknown;

    const { addCommentTool } = await import("../lib/tools/comment-add");
    const result = await invoke(
      addCommentTool,
      { task_gid: "1216960660986098", text: "original body" },
      ctx,
    );
    const text = firstText(result);

    // The POST used the EDITED text, not the agent's original draft.
    const postBody = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    expect(postBody).toEqual({ data: { text: "edited body" } });
    // The result tells the agent the draft was changed and exactly what shipped.
    expect(text).toContain("Edited by user: yes");
    expect(text).toContain("edited body");
    expect(result.details).toMatchObject({
      postedContent: "edited body",
      edited: true,
    });
  });
});

describe("asana_add_comment html_text validation", () => {
  beforeEach(() => {
    process.env.ASANA_ACCESS_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ASANA_ACCESS_TOKEN;
  });

  // Asana does not 400 on bad html_text; it silently stores the whole comment
  // as literal text (HTTP 201). The guard refuses such payloads before any
  // network call so the agent can fix and retry.
  it("refuses html=true without a <body> wrapper and never calls Asana", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { addCommentTool } = await import("../lib/tools/comment-add");
    const text = firstText(
      await invoke(addCommentTool, {
        task_gid: "1",
        html: true,
        text: "<strong>hi</strong>",
      }),
    );

    expect(text).toContain("refused to post html_text");
    expect(text).toContain("<body>");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses html=true with a <br> tag (the silent-fallback footgun)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { addCommentTool } = await import("../lib/tools/comment-add");
    const text = firstText(
      await invoke(addCommentTool, {
        task_gid: "1",
        html: true,
        text: "<body>one<br>two</body>",
      }),
    );

    expect(text).toContain("Unsupported tag");
    expect(text).toContain("<br>");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses html=true with a <p> tag", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { addCommentTool } = await import("../lib/tools/comment-add");
    const text = firstText(
      await invoke(addCommentTool, {
        task_gid: "1",
        html: true,
        text: "<body><p>x</p></body>",
      }),
    );

    expect(text).toContain("<p>");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts html=true with a valid <body> + mention and sends html_text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(storyResponse("777", "2026-08-10T00:00:00.000Z"))
      .mockResolvedValueOnce(taskResponse("1"));
    vi.stubGlobal("fetch", fetchMock);

    const { addCommentTool } = await import("../lib/tools/comment-add");
    const text = firstText(
      await invoke(addCommentTool, {
        task_gid: "1",
        html: true,
        text: '<body>Hi <a data-asana-gid="123"></a></body>',
      }),
    );

    expect(text).toContain("story gid: 777");
    // First fetch is the POST /stories; its body must carry html_text.
    const postBody = fetchMock.mock.calls[0][1].body as string;
    expect(postBody).toContain('"html_text"');
    expect(postBody).toContain("<body>");
  });

  it("does not validate html=false (literal tags in plain prose pass as text)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(storyResponse("888", "2026-08-10T00:00:00.000Z"))
      .mockResolvedValueOnce(taskResponse("1"));
    vi.stubGlobal("fetch", fetchMock);

    const { addCommentTool } = await import("../lib/tools/comment-add");
    const text = firstText(
      await invoke(addCommentTool, {
        task_gid: "1",
        text: "see <body> and <br> as literal text",
      }),
    );

    expect(text).toContain("story gid: 888");
    const postBody = fetchMock.mock.calls[0][1].body as string;
    expect(postBody).toContain('"text"');
    expect(postBody).not.toContain('"html_text"');
  });
});
