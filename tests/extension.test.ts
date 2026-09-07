import { describe, expect, it, vi, afterEach } from "vitest";
import factory from "../extensions/agentmemory/index.js";
import { isServerHealthy } from "../extensions/agentmemory/server.js";

describe("pi-agentmemory extension entry", () => {
  it("registers the memory_health tool", async () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const pi: any = new Proxy(
      {
        registerTool: (def: any) => void tools.push(def?.name),
        registerCommand: (name: string) => void commands.push(name),
        getFlag: () => undefined,
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
      {
        get(target, prop) {
          return prop in target ? (target as any)[prop] : () => {};
        },
      },
    );

    await factory(pi);

    expect(tools).toContain("memory_health");
  });
});

describe("isServerHealthy", () => {
  afterEach(() => vi.unstubAllGlobals());

  const base = "http://localhost:3111";
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });

  // Queue responses in call order: first = /health, second = /livez.
  function stubFetchQueue(responses: Array<Response | Error>) {
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const r = responses[i++];
        if (r instanceof Error) throw r;
        return r;
      }),
    );
  }

  it("health 200 healthy => up", async () => {
    stubFetchQueue([jsonResponse(200, { status: "healthy" })]);
    expect(await isServerHealthy(base)).toBe(true);
  });

  it("health 200 unhealthy => down", async () => {
    stubFetchQueue([jsonResponse(200, { status: "unhealthy" })]);
    expect(await isServerHealthy(base)).toBe(false);
  });

  it("health 503, strict (post-spawn poll) => down without livez probe", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, {}));
    vi.stubGlobal("fetch", fetchMock);
    expect(await isServerHealthy(base)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never asked livez
  });

  it("health 503 + livez 200 => already running (fallback)", async () => {
    stubFetchQueue([jsonResponse(503, {}), jsonResponse(200, { status: "ok" })]);
    expect(
      await isServerHealthy(base, undefined, { fallbackToLivez: true }),
    ).toBe(true);
  });

  it("health 503 + livez unreachable => down (fallback)", async () => {
    stubFetchQueue([jsonResponse(503, {}), new Error("ECONNREFUSED")]);
    expect(
      await isServerHealthy(base, undefined, { fallbackToLivez: true }),
    ).toBe(false);
  });
});
