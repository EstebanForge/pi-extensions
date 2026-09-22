import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
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

async function callSet(
  params: Record<string, unknown>,
  fetchMock: ReturnType<typeof vi.fn>,
) {
  vi.stubGlobal("fetch", fetchMock);
  const { setCustomFieldsTool } = await import("../lib/tools/custom-fields-set");
  return { text: firstText(await invoke(setCustomFieldsTool, params)), fetchMock };
}

// call[1] of the fetch mock is the PUT (call[0] is the schema GET). Unwrap the
// {data: ...} envelope callAsana adds and return the inner body.
function putBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[1] as [unknown, RequestInit];
  const wrapped = JSON.parse(init.body as string) as { data: Record<string, unknown> };
  return wrapped.data;
}

describe("asana_set_custom_fields", () => {
  it("resolves a text field by name and PUTs {custom_fields: {gid: value}}", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [
              { gid: "a", name: "Testing Site", resource_subtype: "text" },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [
              { gid: "a", name: "Testing Site", display_value: "https://oba.ind.ninja/" },
            ],
          },
        }),
      );

    const { text, fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { "Testing Site": "https://oba.ind.ninja/" } },
      fetchMock,
    );

    expect(putBody(fm)).toEqual({
      custom_fields: { a: "https://oba.ind.ninja/" },
    });
    expect(fm.mock.calls[1]?.[1]).toMatchObject({ method: "PUT" });
    expect(text).toContain("set 1 custom field");
    expect(text).toContain("Testing Site = https://oba.ind.ninja/");
  });

  it("resolves an enum option by NAME to its option gid (not the name)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [
              {
                gid: "b",
                name: "Status",
                resource_subtype: "enum",
                enum_options: [
                  { gid: "o1", name: "In Progress" },
                  { gid: "o2", name: "Done" },
                ],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [{ gid: "b", name: "Status", display_value: "Done" }],
          },
        }),
      );

    const { text, fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { Status: "Done" } },
      fetchMock,
    );

    expect(putBody(fm)).toEqual({ custom_fields: { b: "o2" } });
    expect(text).toContain("Status = Done");
  });

  it("aborts with NO put when the field name is unknown", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        data: {
          gid: "1",
          name: "T",
          custom_fields: [{ gid: "a", name: "Testing Site", resource_subtype: "text" }],
        },
      }),
    );

    const { text, fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { "Mystery Field": "x" } },
      fetchMock,
    );

    // Only the schema GET fired; no PUT.
    expect(fm).toHaveBeenCalledOnce();
    expect(text).toContain("aborted");
    expect(text).toContain('no custom field named "Mystery Field"');
  });

  it("aborts on an invalid enum option and lists the legal ones", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        data: {
          gid: "1",
          name: "T",
          custom_fields: [
            {
              gid: "b",
              name: "Status",
              resource_subtype: "enum",
              enum_options: [
                { gid: "o1", name: "In Progress" },
                { gid: "o2", name: "Done" },
              ],
            },
          ],
        },
      }),
    );

    const { text, fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { Status: "Wat" } },
      fetchMock,
    );

    expect(fm).toHaveBeenCalledOnce();
    expect(text).toContain("aborted");
    expect(text).toContain("not a valid option for Status");
    expect(text).toContain("In Progress, Done");
  });

  it("coerces a number field value and sends a number", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [{ gid: "c", name: "Points", resource_subtype: "number" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [{ gid: "c", name: "Points", display_value: "7" }],
          },
        }),
      );

    const { fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { Points: "7" } },
      fetchMock,
    );

    expect(putBody(fm)).toEqual({ custom_fields: { c: 7 } });
  });

  it("rejects an empty string for a number field (Number('') is 0, not NaN)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        data: {
          gid: "1",
          name: "T",
          custom_fields: [{ gid: "c", name: "Points", resource_subtype: "number" }],
        },
      }),
    );

    const { text, fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { Points: "" } },
      fetchMock,
    );

    // Only the schema GET fired; no PUT, so 0 is never written.
    expect(fm).toHaveBeenCalledOnce();
    expect(text).toContain("aborted");
    expect(text).toContain("Points is a number field");
    expect(text).toContain("empty string is not allowed");
  });

  it("rejects unsupported field types (date/people/multi_enum/formula) instead of coercing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        data: {
          gid: "1",
          name: "T",
          custom_fields: [
            { gid: "d", name: "Due", resource_subtype: "date" },
            { gid: "p", name: "Owner", resource_subtype: "people" },
          ],
        },
      }),
    );

    const { text, fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { Due: "2024-01-01", Owner: "someone" } },
      fetchMock,
    );

    // Only the schema GET fired; no PUT. Both fields rejected with their type.
    expect(fm).toHaveBeenCalledOnce();
    expect(text).toContain("aborted");
    expect(text).toContain('Due is a "date" custom field');
    expect(text).toContain('Owner is a "people" custom field');
  });

  it("clears a field when the value is null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [{ gid: "a", name: "Testing Site", resource_subtype: "text" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [{ gid: "a", name: "Testing Site", display_value: null }],
          },
        }),
      );

    const { fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { "Testing Site": null } },
      fetchMock,
    );

    expect(putBody(fm)).toEqual({ custom_fields: { a: null } });
  });

  it("resolves a field keyed by gid directly (bypassing name lookup)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [{ gid: "a", name: "Testing Site", resource_subtype: "text" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          data: { gid: "1", name: "T", custom_fields: [{ gid: "a", name: "Testing Site", display_value: "x" }] },
        }),
      );

    const { fetchMock: fm } = await callSet(
      // Key is the field gid, not its name.
      { task_gid: "1", fields: { a: "x" } },
      fetchMock,
    );

    expect(putBody(fm)).toEqual({ custom_fields: { a: "x" } });
  });

  it("matches a field name case-insensitively when no exact match exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [{ gid: "b", name: "Status", resource_subtype: "enum", enum_options: [{ gid: "o1", name: "Done" }] }],
          },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({ data: { gid: "1", name: "T", custom_fields: [{ gid: "b", name: "Status", display_value: "Done" }] } }),
      );

    const { fetchMock: fm } = await callSet(
      // Lower-case field name AND lower-case option value both resolve.
      { task_gid: "1", fields: { status: "done" } },
      fetchMock,
    );

    expect(putBody(fm)).toEqual({ custom_fields: { b: "o1" } });
  });

  it("refuses to set a disabled enum option (and omits it from the hint list)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        data: {
          gid: "1",
          name: "T",
          custom_fields: [
            {
              gid: "b",
              name: "Status",
              resource_subtype: "enum",
              enum_options: [
                { gid: "o1", name: "Active" },
                { gid: "o2", name: "Archived", enabled: false },
              ],
            },
          ],
        },
      }),
    );

    const { text, fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { Status: "Archived" } },
      fetchMock,
    );

    expect(fm).toHaveBeenCalledOnce();
    expect(text).toContain("aborted");
    expect(text).toContain('"Archived" is not a valid option');
    // Disabled option is NOT offered as a legal choice.
    expect(text).not.toContain("Archived, ");
    expect(text).toContain("Options: Active");
  });

  it("refuses an ambiguous field name shared by two fields (lists both gids)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        data: {
          gid: "1",
          name: "T",
          // Same name from two projects, distinct gids.
          custom_fields: [
            { gid: "x1", name: "Owner", resource_subtype: "text" },
            { gid: "x2", name: "Owner", resource_subtype: "text" },
          ],
        },
      }),
    );

    const { text, fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { Owner: "someone" } },
      fetchMock,
    );

    expect(fm).toHaveBeenCalledOnce();
    expect(text).toContain("aborted");
    expect(text).toContain('"Owner" is ambiguous');
    expect(text).toContain("x1, x2");
    expect(text).toContain("Set it by gid");
  });

  it("aborts the whole batch when any field is invalid (no partial PUT)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        data: {
          gid: "1",
          name: "T",
          custom_fields: [{ gid: "a", name: "Testing Site", resource_subtype: "text" }],
        },
      }),
    );

    const { text, fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { "Testing Site": "ok", "Mystery": "x" } },
      fetchMock,
    );

    expect(fm).toHaveBeenCalledOnce();
    expect(text).toContain("aborted");
    expect(text).toContain('Mystery: no custom field named');
  });

  it("surfaces an Asana server error when the PUT fails after confirm", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [{ gid: "a", name: "Testing Site", resource_subtype: "text" }],
          },
        }),
      )
      // PUT blows up server-side after the (auto-proceeding headless) gate.
      .mockResolvedValueOnce(makeResponse({ errors: [{ message: "boom" }] }, 500));

    const { text, fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { "Testing Site": "ok" } },
      fetchMock,
    );

    expect(fm).toHaveBeenCalledTimes(2);
    expect(text).toContain("Asana server error");
  });

  it("asks the schema GET for permalink_url and the full field projection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            gid: "1",
            name: "T",
            custom_fields: [{ gid: "a", name: "Testing Site", resource_subtype: "text" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({ data: { gid: "1", name: "T", custom_fields: [{ gid: "a", display_value: "x" }] } }),
      );

    const { fetchMock: fm } = await callSet(
      { task_gid: "1", fields: { "Testing Site": "x" } },
      fetchMock,
    );

    const getUrl = fm.mock.calls[0][0] as string;
    expect(getUrl).toContain("/tasks/1");
    expect(getUrl).toContain("permalink_url");
    expect(getUrl).toContain("custom_fields.enum_options");
  });
});

describe("asana_set_custom_fields review gate (interactive UI)", () => {
  beforeEach(() => {
    process.env.ASANA_ACCESS_TOKEN = "test-token";
    // Point the gate's settings file at a dir with no pi-asana-me.json so the
    // gate resolves to its default (ON), deterministically, without touching
    // the developer's real config.
    process.env.PI_CODING_AGENT_DIR = tmpdir();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ASANA_ACCESS_TOKEN;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  function schemaResponse(permalink?: string) {
    return makeResponse({
      data: {
        gid: "1",
        name: "Deploy Task",
        permalink_url: permalink ?? null,
        custom_fields: [{ gid: "a", name: "Testing Site", resource_subtype: "text" }],
      },
    });
  }

  it("cancels on a false confirm: no PUT, reports nothing was changed", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(schemaResponse("https://app.asana.com/0/1/1"));
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.fn().mockResolvedValue(false);
    const ctx = { hasUI: true, ui: { confirm } } as unknown;

    const { setCustomFieldsTool } = await import("../lib/tools/custom-fields-set");
    const text = firstText(
      await invoke(setCustomFieldsTool, { task_gid: "1", fields: { "Testing Site": "x" } }, ctx),
    );

    expect(confirm).toHaveBeenCalledOnce();
    // Schema GET only; the PUT never fired.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(text).toContain("cancelled by user");
    expect(text).toContain("Nothing was changed");
  });

  it("proceeds on a true confirm: PUT fires with the resolved body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(schemaResponse("https://app.asana.com/0/1/1"))
      .mockResolvedValueOnce(
        makeResponse({ data: { gid: "1", name: "Deploy Task", custom_fields: [{ gid: "a", name: "Testing Site", display_value: "x" }] } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.fn().mockResolvedValue(true);
    const ctx = { hasUI: true, ui: { confirm } } as unknown;

    const { setCustomFieldsTool } = await import("../lib/tools/custom-fields-set");
    await invoke(setCustomFieldsTool, { task_gid: "1", fields: { "Testing Site": "x" } }, ctx);

    expect(confirm).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2); // schema GET + PUT
    expect(putBody(fetchMock)).toEqual({ custom_fields: { a: "x" } });
  });

  it("shows the task name, permalink, and field summary in the confirm dialog", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(schemaResponse("https://app.asana.com/0/1/1"))
      .mockResolvedValueOnce(makeResponse({ data: { gid: "1", name: "Deploy Task", custom_fields: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.fn().mockResolvedValue(true);
    const ctx = { hasUI: true, ui: { confirm } } as unknown;

    const { setCustomFieldsTool } = await import("../lib/tools/custom-fields-set");
    await invoke(setCustomFieldsTool, { task_gid: "1", fields: { "Testing Site": "https://example.com" } }, ctx);

    const [title, summary] = confirm.mock.calls[0] as [string, string];
    expect(title).toContain("Deploy Task");
    expect(summary).toContain("https://app.asana.com/0/1/1");
    expect(summary).toContain("Testing Site = https://example.com");
  });
});
