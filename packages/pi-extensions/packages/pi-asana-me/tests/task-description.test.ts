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

async function callGetDescription(
  params: Record<string, unknown>,
  fetchMock = vi.fn(),
) {
  vi.stubGlobal("fetch", fetchMock);
  const { getTaskDescriptionTool } = await import("../lib/tools/task-description");
  return { text: firstText(await invoke(getTaskDescriptionTool, params)), fetchMock };
}

describe("asana_get_task_description", () => {
  it("returns the full notes with no truncation", async () => {
    // Well past the 2000-char cap in asana_get_task. The whole body must
    // survive intact here.
    const longBody = "x".repeat(3000);
    const { text, fetchMock } = await callGetDescription(
      { gid: "1216075846710343" },
      vi.fn().mockResolvedValue(
        makeResponse({
          data: { gid: "1216075846710343", name: "Big task", notes: longBody },
        }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    // The request asks only for name + notes (cheap projection).
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const optFields = new URL(calledUrl).searchParams.get("opt_fields") ?? "";
    expect(optFields).toBe("name,notes");

    expect(text).toContain("Task 1216075846710343:");
    expect(text).toContain("name: Big task");
    expect(text).toContain(`description: ${longBody}`);
    expect(text).not.toContain("truncated");
  });

  it("requests the cheap name,notes projection even though the source is large", async () => {
    const { fetchMock } = await callGetDescription(
      { gid: "1" },
      vi.fn().mockResolvedValue(
        makeResponse({ data: { gid: "1", name: "n", notes: "hi" } }),
      ),
    );
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(new URL(calledUrl).searchParams.get("opt_fields")).toBe("name,notes");
  });

  it("prints an empty description line when the task has no body", async () => {
    const { text } = await callGetDescription(
      { gid: "9" },
      vi.fn().mockResolvedValue(
        makeResponse({ data: { gid: "9", name: "Empty", notes: "" } }),
      ),
    );
    expect(text).toContain("description: ");
  });

  it("returns a not-found message on 404", async () => {
    const { text } = await callGetDescription(
      { gid: "bogus" },
      vi.fn().mockResolvedValue(
        makeResponse({ errors: [{ message: "not_found" }] }, 404),
      ),
    );
    expect(text).toContain("not found");
    expect(text).toContain("asana_search_objects");
  });
});
