import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke, firstText } from "./_helpers";

beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASANA_ACCESS_TOKEN;
});

function emptyResponse() {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [] }),
    json: async () => ({ data: [] }),
  } as unknown as Response;
}

async function callGetTasks(
  params: Record<string, unknown>,
  fetchMock = vi.fn().mockResolvedValue(emptyResponse()),
) {
  vi.stubGlobal("fetch", fetchMock);
  const { getTasksTool } = await import("../lib/tools/tasks");
  return { text: firstText(await invoke(getTasksTool, params)), fetchMock };
}

describe("asana_get_tasks filter validation (no wasted round-trips)", () => {
  it("rejects an empty filter set BEFORE calling fetch", async () => {
    const { text, fetchMock } = await callGetTasks({});
    expect(text).toMatch(/requires at least one of project \/ section \/ tag/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects workspace-only (Asana 400s on this combo)", async () => {
    const { text, fetchMock } = await callGetTasks({ workspace: "111" });
    expect(text).toMatch(/only a workspace is not a supported filter/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects assignee-without-workspace-or-project (Asana 400s on this combo)", async () => {
    const { text, fetchMock } = await callGetTasks({ assignee: "me" });
    expect(text).toMatch(/assignee set also requires a workspace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts project alone (project scope is valid)", async () => {
    const { fetchMock } = await callGetTasks({ project: "999" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(new URL(calledUrl).pathname).toBe("/api/1.0/tasks");
    expect(new URL(calledUrl).searchParams.get("project")).toBe("999");
  });

  it("accepts assignee + workspace (the only valid assignee path)", async () => {
    const { fetchMock } = await callGetTasks({ assignee: "me", workspace: "111" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(new URL(calledUrl).searchParams.get("assignee")).toBe("me");
    expect(new URL(calledUrl).searchParams.get("workspace")).toBe("111");
  });
});
