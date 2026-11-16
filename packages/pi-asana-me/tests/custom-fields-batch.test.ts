import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke, firstText } from "./_helpers";

beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "[REDACTED:Env Secret Field]";
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

// Task projections for the schema GETs (one per task, call order follows the
// deduped input order) and PUTs afterwards.
function mockTwoTasks(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock
    .mockResolvedValueOnce(
      makeResponse({
        data: {
          gid: "1",
          name: "Task One",
          permalink_url: "https://app.asana.com/task/1",
          custom_fields: [
            {
              gid: "f1",
              name: "Wicket Web Effort",
              resource_subtype: "enum",
              enum_options: [
                { gid: "o1", name: "1", enabled: true },
                { gid: "o3", name: "3", enabled: true },
                { gid: "o5", name: "5", enabled: true },
              ],
            },
          ],
        },
      }),
    )
    .mockResolvedValueOnce(
      makeResponse({
        data: {
          gid: "2",
          name: "Task Two",
          permalink_url: "https://app.asana.com/task/2",
          custom_fields: [
            {
              gid: "f2",
              name: "Wicket Web Effort",
              resource_subtype: "enum",
              enum_options: [
                { gid: "p1", name: "1", enabled: true },
                { gid: "p3", name: "3", enabled: true },
              ],
            },
          ],
        },
      }),
    );
}

async function callBatch(params: Record<string, unknown>, fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const { batchSetCustomFieldsTool } = await import("../lib/tools/custom-fields-batch");
  return firstText(await invoke(batchSetCustomFieldsTool, params));
}

function putBody(fetchMock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[call] as [unknown, RequestInit];
  return (JSON.parse(init.body as string) as { data: Record<string, unknown> }).data;
}

describe("asana_batch_set_custom_fields", () => {
  it("resolves per-task names to gids, gates once, and PUTs per task", async () => {
    const fetchMock = vi.fn();
    mockTwoTasks(fetchMock);
    // One success PUT per task echoing the new value.
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          data: { gid: "1", name: "Task One", custom_fields: [{ gid: "f1", name: "Wicket Web Effort", display_value: "3" }] },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          data: { gid: "2", name: "Task Two", custom_fields: [{ gid: "f2", name: "Wicket Web Effort", display_value: "1" }] },
        }),
      );

    const text = await callBatch(
      {
        tasks: [
          { gid: "1", fields: { "Wicket Web Effort": "3" } },
          { gid: "2", fields: { "Wicket Web Effort": "1" } },
        ],
      },
      fetchMock,
    );

    // Two schema GETs then two PUTs.
    expect(fetchMock.mock.calls).toHaveLength(4);
    expect(putBody(fetchMock, 2).custom_fields).toEqual({ f1: "o3" });
    expect(putBody(fetchMock, 3).custom_fields).toEqual({ f2: "p1" });
    expect(text).toMatch(/2\/2 tasks updated/);
    expect(text).toMatch(/Task One: Wicket Web Effort = 3/);
    expect(text).toMatch(/Task Two: Wicket Web Effort = 1/);
  });

  it("aborts before any write when one task has an unknown field name", async () => {
    const fetchMock = vi.fn();
    mockTwoTasks(fetchMock);
    const text = await callBatch(
      {
        tasks: [
          { gid: "1", fields: { "Wicket Web Effort": "3" } },
          { gid: "2", fields: { "Wicket Web Impossible": "1" } },
        ],
      },
      fetchMock,
    );
    expect(text).toMatch(/aborted batch set; nothing was written/);
    expect(text).toMatch(/Wicket Web Impossible/);
    // Only the two schema GETs ran; no PUT reached Asana.
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it("reports per-task failures without rolling back earlier successes", async () => {
    const fetchMock = vi.fn();
    mockTwoTasks(fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          data: { gid: "1", name: "Task One", custom_fields: [{ gid: "f1", name: "Wicket Web Effort", display_value: "3" }] },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({ errors: [{ message: "field is not on given object" }] }, 400),
      );

    const text = await callBatch(
      {
        tasks: [
          { gid: "1", fields: { "Wicket Web Effort": "3" } },
          { gid: "2", fields: { "Wicket Web Effort": "1" } },
        ],
      },
      fetchMock,
    );
    expect(text).toMatch(/1\/2 tasks updated/);
    expect(text).toMatch(/Task One: Wicket Web Effort = 3/);
    expect(text).toMatch(/Task Two.*field is not on given object/s);
  });
});
