import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolveTasks, fmtTask, type ResolvedRef } from "../lib/resolve";

beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASANA_ACCESS_TOKEN;
});

// callAsana unwraps the Asana {data: ...} envelope, so the fetch mock returns
// the full envelope and the resolver hands back the inner object.
function taskResponse(gid: string, name: string, permalink_url: string) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: { gid, name, permalink_url } }),
    json: async () => ({ data: { gid, name, permalink_url } }),
  } as unknown as Response;
}

function errorResponse(status: number, message: string) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ errors: [{ message }] }),
    json: async () => ({ errors: [{ message }] }),
  } as unknown as Response;
}

describe("resolveTasks", () => {
  it("resolves each gid to {name, permalink_url}", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(taskResponse("111", "Fix login", "https://app.asana.com/0/1/111"))
        .mockResolvedValueOnce(taskResponse("222", "Ship", "https://app.asana.com/0/1/222")),
    );

    const map = await resolveTasks(["111", "222"]);
    expect(map.get("111")).toEqual<ResolvedRef>({
      name: "Fix login",
      permalink_url: "https://app.asana.com/0/1/111",
    });
    expect(map.get("222")).toEqual<ResolvedRef>({
      name: "Ship",
      permalink_url: "https://app.asana.com/0/1/222",
    });
  });

  it("dedupes input so a repeated gid hits Asana once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(taskResponse("111", "X", "u"));
    vi.stubGlobal("fetch", fetchMock);

    await resolveTasks(["111", "222", "111"]);

    // 111 appears twice in input but only the deduped set {111, 222} is fetched.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("/tasks/111?")).length).toBe(1);
  });

  it("swallows a per-gid failure instead of failing the whole batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(errorResponse(404, "not_found: task does not exist"))
        .mockResolvedValueOnce(taskResponse("222", "Ship", "u2")),
    );

    const map = await resolveTasks(["111", "222"]);
    expect(map.has("111")).toBe(false); // 404 -> unresolved, not thrown
    expect(map.get("222")?.name).toBe("Ship");
  });

  it("returns an empty map for no gids and issues no requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const map = await resolveTasks([]);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests name + permalink_url opt_fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(taskResponse("111", "X", "u"));
    vi.stubGlobal("fetch", fetchMock);

    await resolveTasks(["111"]);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("opt_fields=name%2Cpermalink_url");
    expect(url).toMatch(/\/api\/1\.0\/tasks\/111/);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });
});

describe("fmtTask", () => {
  it("renders name + url when fully resolved", () => {
    expect(
      fmtTask("111", { name: "Fix login", permalink_url: "https://app.asana.com/0/1/111" }),
    ).toBe("'Fix login' (https://app.asana.com/0/1/111)");
  });

  it("renders name + gid when named but URL-less", () => {
    expect(fmtTask("111", { name: "Fix login" })).toBe("'Fix login' (gid: 111)");
  });

  it("trims whitespace in the resolved name", () => {
    expect(fmtTask("111", { name: "  Spaced  " })).toBe("'Spaced' (gid: 111)");
  });

  it("falls back to a bare gid when unresolved", () => {
    expect(fmtTask("111", undefined)).toBe("gid: 111");
    expect(fmtTask("111", {})).toBe("gid: 111");
  });
});
