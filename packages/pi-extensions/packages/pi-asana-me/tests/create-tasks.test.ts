import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke, firstText } from "./_helpers";

beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASANA_ACCESS_TOKEN;
});

function postCreatedResponse(name: string, gid: string) {
  return {
    ok: true,
    status: 201,
    text: async () => JSON.stringify({ data: { gid, name } }),
    json: async () => ({ data: { gid, name } }),
  } as unknown as Response;
}

describe("asana_create_tasks batch handling", () => {
  it("calls POST /tasks once per task in the batch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(postCreatedResponse("Task A", "1"))
      .mockResolvedValueOnce(postCreatedResponse("Task B", "2"));
    vi.stubGlobal("fetch", fetchMock);

    const { createTasksTool } = await import("../lib/tools/create-tasks");
    await invoke(createTasksTool, { tasks: [{ name: "Task A" }, { name: "Task B" }] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url).toMatch(/\/api\/1\.0\/tasks/);
      expect(call[1]).toMatchObject({ method: "POST" });
    }
  });

  it("REJECTS spec with both projects (array) AND project (singular) rather than overwriting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(postCreatedResponse("ok", "1"));
    vi.stubGlobal("fetch", fetchMock);

    const { createTasksTool } = await import("../lib/tools/create-tasks");
    const text = firstText(
      await invoke(createTasksTool, {
        tasks: [
          { name: "Bad", projects: ["a", "b"], project: "c" },
          { name: "Good" },
        ],
      }),
    );

    expect(text).toContain('task #1: task spec sets both "projects"');
    // Only the second task should have been posted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).toMatch(/1 of 2 task/);
    expect(text).toContain("Failures (1)");
  });

  it("each task is wrapped in the {data: ...} envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(postCreatedResponse("A", "1"));
    vi.stubGlobal("fetch", fetchMock);

    const { createTasksTool } = await import("../lib/tools/create-tasks");
    await invoke(createTasksTool, {
      workspace: "111",
      tasks: [{ name: "A", due_on: "2026-12-31" }],
    });

    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const body = JSON.parse(init.body as string) as { data: Record<string, unknown> };
    expect(body).toEqual({
      data: { name: "A", due_on: "2026-12-31", workspace: "111" },
    });
  });

  it("per-task failures are aggregated, not thrown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(postCreatedResponse("A", "1"))
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ errors: [{ message: "bad input" }] }),
        json: async () => ({ errors: [{ message: "bad input" }] }),
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const { createTasksTool } = await import("../lib/tools/create-tasks");
    const text = firstText(await invoke(createTasksTool, { tasks: [{ name: "A" }, { name: "B" }] }));
    expect(text).toContain("1 of 2 task");
    expect(text).toContain("Failures (1)");
    expect(text).toContain("task #2:");
  });
});
