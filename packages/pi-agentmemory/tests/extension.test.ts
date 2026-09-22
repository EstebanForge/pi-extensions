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
      vi.fn(async (_url: unknown, _init?: unknown) => {
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

describe("status bar resilience", () => {
  afterEach(() => vi.unstubAllGlobals());

  function makeFakePi() {
    const handlers: Record<string, any> = {};
    const setStatus = vi.fn();
    const pi: any = new Proxy(
      {
        registerTool: () => {},
        registerCommand: () => {},
        getFlag: () => undefined,
        on: (event: string, handler: any) => {
          handlers[event] = handler;
        },
      },
      {
        get(target, prop) {
          return prop in target ? (target as any)[prop] : () => {};
        },
      },
    );
    return { pi, handlers, setStatus };
  }

  const ctxOf = (setStatus: any) => ({ ui: { setStatus } });
  const jsonResponse = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status });

  function stubFetchQueue(responses: Array<Response | Error>) {
    let i = 0;
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => {
      const r = responses[i++];
      if (r instanceof Error) throw r;
      return r;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("bar shows degraded (~), not off, when health fails but livez answers", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    stubFetchQueue([
      jsonResponse(503), // refreshStatus /health
      jsonResponse(200, { status: "ok" }), // /livez
    ]);
    const res = await handlers.before_agent_start(
      { systemPromptOptions: { cwd: "/tmp" }, prompt: "", systemPrompt: "" },
      ctxOf(setStatus),
    );
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    expect(setStatus).toHaveBeenCalledWith("agentmemory", "🧠 agentmemory~");
    // Agents obey the bar; guidance tells them to try anyway.
    expect(res.systemPrompt).toContain("still try the memory tools");
  });

  it("bar stays off only when health AND livez both fail", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    stubFetchQueue([
      jsonResponse(503), // refreshStatus /health
      new Error("ECONNREFUSED"), // /livez
    ]);
    await handlers.before_agent_start(
      { systemPromptOptions: { cwd: "/tmp" }, prompt: "", systemPrompt: "" },
      ctxOf(setStatus),
    );
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    expect(setStatus).toHaveBeenCalledWith("agentmemory", "🧠 agentmemory off");
  });

  it("bar stays off on 401 (durable auth failure gets no livez fallback)", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    const fetchMock = stubFetchQueue([jsonResponse(401)]); // /health only
    await handlers.before_agent_start(
      { systemPromptOptions: { cwd: "/tmp" }, prompt: "", systemPrompt: "" },
      ctxOf(setStatus),
    );
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    expect(setStatus).toHaveBeenCalledWith("agentmemory", "🧠 agentmemory off");
    expect(fetchMock).toHaveBeenCalledTimes(1); // livez never asked
  });

  it("agent_end always attempts the observation, even after an off turn", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    const fetchMock = stubFetchQueue([
      jsonResponse(503), // pendingSearch POST /search (prompt non-empty)
      jsonResponse(503), // refreshStatus /health
      new Error("ECONNREFUSED"), // refreshStatus /livez -> bar off
      jsonResponse(200, { saved: true }), // POST /observe (no gate, no probe)
    ]);
    await handlers.before_agent_start(
      {
        systemPromptOptions: { cwd: "/tmp" },
        prompt: "remember this",
        systemPrompt: "",
      },
      ctxOf(setStatus),
    );
    await vi.waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith(
        "agentmemory",
        "🧠 agentmemory off",
      ),
    );
    await handlers.agent_end({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    });
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) =>
          String(c[0]).endsWith("/agentmemory/observe"),
        ),
      ).toBe(true),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("observation retry queue", () => {
  afterEach(() => vi.unstubAllGlobals());

  function makeFakePi() {
    const handlers: Record<string, any> = {};
    const setStatus = vi.fn();
    const pi: any = new Proxy(
      {
        registerTool: () => {},
        registerCommand: () => {},
        getFlag: () => undefined,
        on: (event: string, handler: any) => {
          handlers[event] = handler;
        },
      },
      {
        get(target, prop) {
          return prop in target ? (target as any)[prop] : () => {};
        },
      },
    );
    return { pi, handlers, setStatus };
  }

  const ctxOf = (setStatus: any) => ({ ui: { setStatus } });
  const jsonResponse = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status });
  const observeCalls = (fetchMock: any) =>
    fetchMock.mock.calls.filter((c: unknown[]) =>
      String(c[0]).endsWith("/agentmemory/observe"),
    ).length;

  function stubFetchQueue(responses: Array<Response | Error>) {
    let i = 0;
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => {
      const r = responses[i++];
      if (r instanceof Error) throw r;
      return r;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const AGENT_END = (text: string) => ({
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  });
  const START = (prompt: string) => ({
    systemPromptOptions: { cwd: "/tmp" },
    prompt,
    systemPrompt: "",
  });

  it("observation posted during an outage is queued and flushed on recovery", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    const fetchMock = stubFetchQueue([
      jsonResponse(503), // search q1
      jsonResponse(503), // refresh /health
      new Error("ECONNREFUSED"), // refresh /livez -> off
      jsonResponse(503), // agent_end observe fails -> queued
      jsonResponse(200, { results: [] }), // search q2 (recovery)
      jsonResponse(200, { status: "healthy" }), // refresh /health
      jsonResponse(200, { saved: true }), // flush observe
    ]);
    await handlers.before_agent_start(START("q1"), ctxOf(setStatus));
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    await handlers.agent_end(AGENT_END("a1"));
    await vi.waitFor(() => expect(observeCalls(fetchMock)).toBe(1));
    await handlers.before_agent_start(START("q2"), ctxOf(setStatus));
    await vi.waitFor(() => expect(observeCalls(fetchMock)).toBe(2));
  });

  it("observation queue is capped, dropping the oldest", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    const fetchMock = stubFetchQueue([
      jsonResponse(503), // search (seed)
      jsonResponse(503), // refresh /health
      new Error("ECONNREFUSED"), // refresh /livez -> off
      ...Array.from({ length: 51 }, () => jsonResponse(503)), // 51 failed observes
      jsonResponse(200, { results: [] }), // recovery search
      jsonResponse(200, { status: "healthy" }), // refresh /health
      ...Array.from({ length: 50 }, () => jsonResponse(200, { saved: true })), // 50 flushed
    ]);
    await handlers.before_agent_start(START("seed"), ctxOf(setStatus));
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    for (let i = 0; i < 51; i++) {
      await handlers.agent_end(AGENT_END(`a${i}`));
    }
    await vi.waitFor(() => expect(observeCalls(fetchMock)).toBe(51));
    await handlers.before_agent_start(START("recover"), ctxOf(setStatus));
    // Only the 50 newest flush; the 51st (oldest) was dropped by the cap.
    await vi.waitFor(() => expect(observeCalls(fetchMock)).toBe(101));
  });

  it("flush stops at the first failure and resumes on the next success", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    const fetchMock = stubFetchQueue([
      jsonResponse(503), // search (seed)
      jsonResponse(503), // refresh /health
      new Error("ECONNREFUSED"), // refresh /livez -> off
      jsonResponse(503), // observe a1 -> queued
      jsonResponse(503), // observe a2 -> queued
      jsonResponse(200, { results: [] }), // recovery search r1
      jsonResponse(200, { status: "healthy" }), // refresh /health
      jsonResponse(200, { saved: true }), // flush a1 ok
      jsonResponse(503), // flush a2 fails, rotates to tail
      jsonResponse(200, { results: [] }), // recovery search r2
      jsonResponse(200, { status: "healthy" }), // refresh /health
      jsonResponse(200, { saved: true }), // flush a2 ok
    ]);
    await handlers.before_agent_start(START("seed"), ctxOf(setStatus));
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    await handlers.agent_end(AGENT_END("a1"));
    await handlers.agent_end(AGENT_END("a2"));
    await vi.waitFor(() => expect(observeCalls(fetchMock)).toBe(2));
    await handlers.before_agent_start(START("r1"), ctxOf(setStatus));
    // Flush posts a1 (ok) then attempts a2 (503, rotates to tail): 2 + 2 = 4.
    await vi.waitFor(() => expect(observeCalls(fetchMock)).toBe(4));
    await handlers.before_agent_start(START("r2"), ctxOf(setStatus));
    // Only a2 re-posts. 5 = no double-post, no drop on flush failure.
    await vi.waitFor(() => expect(observeCalls(fetchMock)).toBe(5));
  });

  it("poison item rotates to the tail and cannot head-block the queue", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    const fetchMock = stubFetchQueue([
      // setup: each item needs its own prompt turn (tool_input = lastPrompt)
      jsonResponse(503), jsonResponse(200, { status: "healthy" }),
      jsonResponse(503), // search, health, observe a1 -> queued
      jsonResponse(503), jsonResponse(200, { status: "healthy" }),
      jsonResponse(503), // search, health, observe a2 -> queued
      jsonResponse(503), jsonResponse(200, { status: "healthy" }),
      jsonResponse(503), // search, health, observe a3 -> queued
      jsonResponse(200, { results: [] }), // recovery search r1
      jsonResponse(200, { status: "healthy" }), // refresh /health
      jsonResponse(503), // flush a1 fails -> rotates, stop
      jsonResponse(200, { results: [] }), // recovery search r2
      jsonResponse(200, { status: "healthy" }), // refresh /health
      jsonResponse(200, { saved: true }), // flush a2 ok
      jsonResponse(200, { saved: true }), // flush a3 ok
      jsonResponse(503), // flush a1 fails again -> rotates, stop
    ]);
    for (const label of ["a1", "a2", "a3"]) {
      await handlers.before_agent_start(START(label), ctxOf(setStatus));
      await handlers.agent_end(AGENT_END(label));
    }
    await vi.waitFor(() => expect(observeCalls(fetchMock)).toBe(3));
    await handlers.before_agent_start(START("r1"), ctxOf(setStatus));
    await vi.waitFor(() => expect(observeCalls(fetchMock)).toBe(4));
    await handlers.before_agent_start(START("r2"), ctxOf(setStatus));
    // Goods (a2, a3) flow before the poison item is retried.
    await vi.waitFor(() => expect(observeCalls(fetchMock)).toBe(7));
    const inputs = fetchMock.mock.calls
      .filter((c: unknown[]) => String(c[0]).endsWith("/agentmemory/observe"))
      .map((c: any) => JSON.parse(c[1].body).data.tool_input);
    expect(inputs).toEqual([
      "a1", "a2", "a3", "a1", "a2", "a3", "a1",
    ]);
  });

  it("cap evicting the in-flight head never loses a never-posted item", async () => {
    const { pi, handlers } = makeFakePi();
    await factory(pi);
    let searchOk = false;
    const observeStatuses: number[] = [];
    let gateArmed = false;
    let releaseGate!: (r: Response) => void;
    const gated = new Promise<Response>((r) => (releaseGate = r));
    const observePosts: { status: number; input: string }[] = [];
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/agentmemory/health")) {
        return jsonResponse(200, { status: "healthy" });
      }
      if (u.endsWith("/agentmemory/search")) {
        return jsonResponse(searchOk ? 200 : 503, { results: [] });
      }
      if (u.endsWith("/agentmemory/observe")) {
        let status: number;
        if (gateArmed) {
          gateArmed = false;
          await gated;
          status = 200;
        } else {
          status = observeStatuses.shift() ?? 200;
        }
        const input = JSON.parse(init?.body ?? "{}").data.tool_input;
        observePosts.push({ status, input });
        return jsonResponse(status, { saved: true });
      }
      return jsonResponse(200, { status: "ok" }); // livez
    });
    vi.stubGlobal("fetch", fetchMock);

    // Fill the queue to the cap with 50 failed observations.
    observeStatuses.push(...Array.from({ length: 50 }, () => 503));
    for (let i = 0; i < 50; i++) {
      await handlers.before_agent_start(START(`t${i}`), ctxOf(() => {}));
      await handlers.agent_end(AGENT_END(`t${i}`));
    }
    await vi.waitFor(() =>
      expect(observePosts.filter((p) => p.status === 503).length).toBe(50),
    );

    // Recovery search starts a flush whose first POST (t0) hangs on the gate.
    gateArmed = true;
    searchOk = true;
    await handlers.before_agent_start(START("recover"), ctxOf(() => {}));
    await vi.waitFor(() => expect(gateArmed).toBe(false));
    // A same-cap enqueue while t0 is in flight evicts t0 from the array.
    // agent_end stamps tool_input from lastPrompt, so give the late turn
    // its own prompt turn first (its flush trigger no-ops: already flushing).
    observeStatuses.push(503);
    await handlers.before_agent_start(START("late"), ctxOf(() => {}));
    await handlers.agent_end(AGENT_END("late"));
    // t0's POST then succeeds: identity-based removal must not shift t1.
    releaseGate(jsonResponse(200, { saved: true }));

    await vi.waitFor(() =>
      expect(observePosts.filter((p) => p.status === 200).length).toBe(51),
    );
    const posted = observePosts.filter((p) => p.status === 200).map((p) => p.input);
    for (let i = 1; i < 50; i++) {
      expect(posted).toContain(`t${i}`);
    }
    expect(posted).toContain("late");
  });
});
