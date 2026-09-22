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

async function callGet(
  params: Record<string, unknown>,
  fetchMock = vi.fn(),
) {
  vi.stubGlobal("fetch", fetchMock);
  const { getCustomFieldsTool } = await import("../lib/tools/custom-fields-get");
  return { text: firstText(await invoke(getCustomFieldsTool, params)), fetchMock };
}

describe("asana_get_custom_fields", () => {
  it("lists each field with type, value, and enum options", async () => {
    const { text, fetchMock } = await callGet(
      { gid: "1" },
      vi.fn().mockResolvedValue(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [
              {
                gid: "a",
                name: "Testing Site",
                resource_subtype: "text",
                display_value: "https://oba.ind.ninja/",
              },
              {
                gid: "b",
                name: "Status",
                resource_subtype: "enum",
                display_value: "In Progress",
                enum_value: { gid: "o1", name: "In Progress" },
                enum_options: [
                  { gid: "o1", name: "In Progress" },
                  { gid: "o2", name: "Done" },
                ],
              },
              {
                gid: "c",
                name: "Points",
                resource_subtype: "number",
                display_value: "5",
              },
            ],
          },
        }),
      ),
    );
    // The full projection must request the enum options subfield.
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const optFields =
      new URL(calledUrl).searchParams.get("opt_fields") ?? "";
    expect(optFields).toContain("custom_fields.enum_options");

    expect(text).toContain("Task 1 (T): 3 custom fields");
    expect(text).toContain("Testing Site [text] (gid: a): https://oba.ind.ninja/");
    expect(text).toContain("Status [enum] (gid: b): In Progress");
    expect(text).toContain("options: In Progress, Done");
    expect(text).toContain("Points [number] (gid: c): 5");
  });

  it("prints a placeholder when the task has no custom fields", async () => {
    const { text } = await callGet(
      { gid: "9" },
      vi.fn().mockResolvedValue(
        makeResponse({ data: { gid: "9", name: "Empty", custom_fields: [] } }),
      ),
    );
    expect(text).toContain("0 custom fields");
    expect(text).toContain("(no custom fields on this task)");
  });

  it("returns a not-found message on 404", async () => {
    const { text } = await callGet(
      { gid: "bogus" },
      vi.fn().mockResolvedValue(
        makeResponse({ errors: [{ message: "not_found" }] }, 404),
      ),
    );
    expect(text).toContain("not found");
    expect(text).toContain("asana_search_objects");
  });
});
