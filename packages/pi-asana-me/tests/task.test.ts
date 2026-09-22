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

async function callGetTask(
  params: Record<string, unknown>,
  fetchMock = vi.fn(),
) {
  vi.stubGlobal("fetch", fetchMock);
  const { getTaskTool } = await import("../lib/tools/task");
  return { text: firstText(await invoke(getTaskTool, params)), fetchMock };
}

// The opt_fields regression test. Live testing surfaced this: agent could
// not see a closed parent task's 5 closed subtasks because the default
// projection did not request them. Lock the behaviour in.
describe("asana_get_task default projection", () => {
  it("default opt_fields includes subtasks, parent, dependencies, dependents", async () => {
    // Synthesized GID. Do NOT pin the live test task GID here; this test
    // is about the opt_fields string, not the actual resource.
    const TEST_TASK_GID = "0000000000000001";
    const { text, fetchMock } = await callGetTask(
      { gid: TEST_TASK_GID },
      vi.fn().mockResolvedValue(
        makeResponse({
          data: {
            gid: TEST_TASK_GID,
            name: "Parent",
            subtasks: [{ gid: "x1", name: "Sub 1", completed: true }],
          },
        }),
      ),
    );
    void text;
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const optFields = new URL(calledUrl).searchParams.get("opt_fields") ?? "";
    expect(optFields).toContain("subtasks.name");
    expect(optFields).toContain("subtasks.completed");
    expect(optFields).toContain("subtasks.completed_at");
    expect(optFields).toContain("parent.gid");
    expect(optFields).toContain("dependencies.gid");
    expect(optFields).toContain("dependents.gid");
  });

  it("opt_fields arg overrides the default projection entirely", async () => {
    const { fetchMock } = await callGetTask(
      { gid: "1", opt_fields: "name" },
      vi.fn().mockResolvedValue(makeResponse({ data: { gid: "1", name: "x" } })),
    );
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const optFields = new URL(calledUrl).searchParams.get("opt_fields") ?? "";
    expect(optFields).toBe("name");
    expect(optFields).not.toContain("subtasks");
  });

  it("renders subtasks list with completion flag + count", async () => {
    const { text } = await callGetTask(
      { gid: "parent" },
      vi.fn().mockResolvedValue(
        makeResponse({
          data: {
            gid: "parent",
            name: "Parent",
            subtasks: [
              { gid: "s1", name: "First sub", completed: true, completed_at: "2026-01-01T00:00:00.000Z" },
              { gid: "s2", name: "Second sub", completed: false },
            ],
          },
        }),
      ),
    );
    expect(text).toMatch(/subtasks \(2 total, 1 closed\)/);
    expect(text).toContain("[x] First sub (gid: s1)");
    expect(text).toContain("[ ] Second sub (gid: s2)");
  });
});

// asana_get_task caps notes at 2000 chars. When the body overflows, it must
// print an explicit marker pointing at asana_get_task_description so the
// agent knows the full text is one call away. Silent truncation is the bug
// this guard exists to prevent.
describe("asana_get_task notes truncation marker", () => {
  it("appends a pointer to asana_get_task_description when notes exceed 2000 chars", async () => {
    const longNotes = "y".repeat(2500);
    const { text } = await callGetTask(
      { gid: "big" },
      vi.fn().mockResolvedValue(
        makeResponse({ data: { gid: "big", name: "Big", notes: longNotes } }),
      ),
    );
    expect(text).toContain("[truncated; call asana_get_task_description for the full text]");
    // Truncated prefix present, but NOT the tail beyond the cap.
    expect(text).toContain("y".repeat(2000));
    expect(text).not.toContain("y".repeat(2001));
  });

  it("renders notes inline with no marker when at or under 2000 chars", async () => {
    const shortNotes = "z".repeat(2000);
    const { text } = await callGetTask(
      { gid: "small" },
      vi.fn().mockResolvedValue(
        makeResponse({ data: { gid: "small", name: "Small", notes: shortNotes } }),
      ),
    );
    expect(text).toContain(`notes: ${shortNotes}`);
    expect(text).not.toContain("truncated");
  });

  // Regression: `if (task.notes)` is falsy for the empty string, which used
  // to drop the notes line entirely. The guard must be type-based so an
  // empty body still renders (as an empty notes line), matching
  // asana_get_task_description's behavior.
  it("renders an empty notes line when notes is an empty string", async () => {
    const { text } = await callGetTask(
      { gid: "empty" },
      vi.fn().mockResolvedValue(
        makeResponse({ data: { gid: "empty", name: "Empty", notes: "" } }),
      ),
    );
    expect(text).toContain("notes: ");
    expect(text).not.toContain("truncated");
  });
});
