import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import factory, {
  parseWatchdogIntervalMinutes,
} from "../extensions/agentmemory/index.js";
import {
  buildSettingsRows,
  selectStagedDeltas,
  stageMenuValue,
} from "../extensions/agentmemory/index.js";
import {
  ensureServer,
  isLoopbackHost,
  isServerHealthy,
} from "../extensions/agentmemory/server.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
// ensureServer spawns on the autostart path; mock file-wide so the remote
// tests can prove no local spawn/npx ever happens for a remote address.
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

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
      { systemPromptOptions: { cwd: "/tmp" }, messageType: "user", prompt: "", systemPrompt: "" },
      ctxOf(setStatus),
    );
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    expect(setStatus).toHaveBeenCalledWith("agentmemory", "🧠 ~");
    // Agents obey the bar; guidance tells them to try anyway.
    expect(res.systemPrompt).toContain("still try the memory tools");
  });

  // Engine watermark state: /health can answer 200 with status "critical"
  // (older builds) while reads and writes keep serving. That is degraded,
  // not down — the bar must not read off while the server works.
  it("bar shows degraded (~) when health answers 200 with status critical", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    stubFetchQueue([jsonResponse(200, { status: "critical" })]);
    await handlers.before_agent_start(
      { systemPromptOptions: { cwd: "/tmp" }, messageType: "user", prompt: "", systemPrompt: "" },
      ctxOf(setStatus),
    );
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    expect(setStatus).toHaveBeenCalledWith("agentmemory", "🧠 ~");
  });

  // A future engine dialect must not read as off while the server serves:
  // unrecognized status words defer to the livez probe like "unknown" does.
  it("bar defers to livez when health answers 200 with an unrecognized status", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    stubFetchQueue([
      jsonResponse(200, { status: "kryogenic" }), // /health, future word
      jsonResponse(200, { status: "ok" }), // /livez
    ]);
    await handlers.before_agent_start(
      { systemPromptOptions: { cwd: "/tmp" }, messageType: "user", prompt: "", systemPrompt: "" },
      ctxOf(setStatus),
    );
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    expect(setStatus).toHaveBeenCalledWith("agentmemory", "🧠 ~");
  });

  it("bar stays off only when health AND livez both fail", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    stubFetchQueue([
      jsonResponse(503), // refreshStatus /health
      new Error("ECONNREFUSED"), // /livez
    ]);
    await handlers.before_agent_start(
      { systemPromptOptions: { cwd: "/tmp" }, messageType: "user", prompt: "", systemPrompt: "" },
      ctxOf(setStatus),
    );
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    expect(setStatus).toHaveBeenCalledWith("agentmemory", "🧠 ×");
  });

  it("bar stays off on 401 (durable auth failure gets no livez fallback)", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    const fetchMock = stubFetchQueue([jsonResponse(401)]); // /health only
    await handlers.before_agent_start(
      { systemPromptOptions: { cwd: "/tmp" }, messageType: "user", prompt: "", systemPrompt: "" },
      ctxOf(setStatus),
    );
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    expect(setStatus).toHaveBeenCalledWith("agentmemory", "🧠 ×");
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
        messageType: "user",
        prompt: "remember this",
        systemPrompt: "",
      },
      ctxOf(setStatus),
    );
    await vi.waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith(
        "agentmemory",
        "🧠 ×",
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
    messageType: "user",
    prompt,
    systemPrompt: "",
  });
  // Pi 1.2.0: runs started by pi.sendMessage({ triggerTurn: true }) (the
  // ask-* wake path) fire before_agent_start with a "custom" event that
  // carries the starting message instead of a user prompt.
  const WAKE = () => ({
    systemPromptOptions: { cwd: "/tmp" },
    systemPrompt: "",
    messageType: "custom",
    message: { customType: "pi-ask-shared/wake", content: "consult finished" },
  });
  const searchCalls = (fetchMock: any) =>
    fetchMock.mock.calls.filter((c: unknown[]) =>
      String(c[0]).endsWith("/agentmemory/search"),
    ).length;

  it("wake run (custom before_agent_start) never triggers recall search", async () => {
    const { pi, handlers, setStatus } = makeFakePi();
    await factory(pi);
    const fetchMock = stubFetchQueue([
      jsonResponse(503), // user turn: search "stale query"
      jsonResponse(503), // user turn: refresh /health
      new Error("ECONNREFUSED"), // user turn: refresh /livez -> off
      jsonResponse(503), // wake run: refresh /health
      new Error("ECONNREFUSED"), // wake run: refresh /livez -> off
    ]);
    // Sequence user turn -> wake run: the wake must RESET lastPrompt, not
    // recall against the previous turn's prompt (a second /search here is
    // the exact regression). Bar + guidance must still ride the wake run.
    await handlers.before_agent_start(START("stale query"), ctxOf(setStatus));
    const res = await handlers.before_agent_start(WAKE(), ctxOf(setStatus));
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
    expect(searchCalls(fetchMock)).toBe(1);
    expect(res.systemPrompt).toContain("still try the memory tools");
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

describe("isLoopbackHost", () => {
  it.each([
    ["http://localhost:3111", true],
    ["http://127.0.0.1:3111", true],
    ["http://127.9.9.9/", true],
    ["http://[::1]:3111", true],
    ["http://pi.localhost:3111", true],
    ["http://10.40.0.7:3111", false],
    ["http://memory.lan:3111", false],
    ["https://memory.example.com", false],
    ["not a url", false],
  ])("%s -> %s", (url, expected) => {
    expect(isLoopbackHost(url as string)).toBe(expected);
  });
});

describe("remote server handling", () => {
  beforeEach(() => spawnMock.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  // runShort resolves on 'close'; spawnServer only needs on('error') + unref.
  const fakeChild = (closeCode: number) => ({
    on: (_event: string, cb: (arg?: unknown) => void) => {
      if (_event === "close") queueMicrotask(() => cb(closeCode));
    },
    kill: () => {},
    unref: () => {},
  });

  const unreachableFetch = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

  it("remote URL: fails fast with remote guidance, never spawns or installs", async () => {
    spawnMock.mockImplementation(() => fakeChild(0));
    unreachableFetch();
    const res = await ensureServer({
      baseUrl: "http://10.40.0.7:3111",
      autostart: true,
      npxFallback: true,
      timeoutMs: 500,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("http://10.40.0.7:3111");
      expect(res.reason).toMatch(/another machine|remote host/i);
      expect(res.reason).toMatch(/do not install/i);
      expect(res.reason).toContain("Retry once");
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("loopback URL, autostart off: keeps the local start-it-manually advice", async () => {
    unreachableFetch();
    const res = await ensureServer({
      baseUrl: "http://localhost:3111",
      autostart: false,
      npxFallback: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("Start it manually");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("loopback URL, autostart on: spawns the local server, then reports timeout", async () => {
    spawnMock.mockImplementation(() => fakeChild(0));
    unreachableFetch();
    const res = await ensureServer({
      baseUrl: "http://localhost:3111",
      autostart: true,
      npxFallback: true,
      timeoutMs: 600,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/did not become healthy/);
    expect(
      spawnMock.mock.calls.some(
        (c) => c[0] === "agentmemory" && (c[1] as string[]).length === 0,
      ),
    ).toBe(true);
  });

  it("system prompt guidance says the server may be remote and forbids local installs", async () => {
    const handlers: Record<string, any> = {};
    const toolDefs: any[] = [];
    const pi: any = new Proxy(
      {
        registerTool: (def: any) => void toolDefs.push(def),
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
    await factory(pi);
    const health = toolDefs.find((t) => t.name === "memory_health");
    expect(health.description).not.toMatch(/\blocal\b/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ status: "healthy" }), { status: 200 }),
      ),
    );
    const res = await handlers.before_agent_start(
      { systemPromptOptions: { cwd: "/tmp" }, messageType: "user", prompt: "", systemPrompt: "" },
      { ui: { setStatus: () => {} } },
    );
    expect(res.systemPrompt).toContain("still try the memory tools");
    expect(res.systemPrompt).toContain("never install or start agentmemory");
  });

  it("memory_search returns ok:false with the retry hint when the call fails", async () => {
    const toolDefs: any[] = [];
    const pi: any = new Proxy(
      {
        registerTool: (def: any) => void toolDefs.push(def),
        registerCommand: () => {},
        getFlag: () => undefined,
      },
      {
        get(target, prop) {
          return prop in target ? (target as any)[prop] : () => {};
        },
      },
    );
    await factory(pi);
    const search = toolDefs.find((t) => t.name === "memory_search");
    // First fetch = ensureServer health check (up); second = search POST,
    // which rejects: the tool must surface the failure, not report
    // "No relevant memories found" with ok:true.
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (i++ === 0) {
          return new Response(JSON.stringify({ status: "healthy" }), {
            status: 200,
          });
        }
        throw new Error("ECONNREFUSED");
      }),
    );
    const res = await search.execute("t1", { query: "auth flow" });
    expect(res.details.ok).toBe(false);
    expect(res.content[0].text).toContain("Search failed");
    expect(res.content[0].text).toContain(
      "Retry once; if it fails again, tell the human.",
    );
  });
});

describe("parseWatchdogIntervalMinutes", () => {
  it("defaults to 5 minutes when unset or empty", () => {
    expect(parseWatchdogIntervalMinutes(undefined)).toBe(5);
    expect(parseWatchdogIntervalMinutes("")).toBe(5);
    expect(parseWatchdogIntervalMinutes("  ")).toBe(5);
  });

  it("parses whole and fractional minutes", () => {
    expect(parseWatchdogIntervalMinutes("5")).toBe(5);
    expect(parseWatchdogIntervalMinutes("10")).toBe(10);
    expect(parseWatchdogIntervalMinutes("0.5")).toBe(0.5);
  });

  it("disables on off, 0, and negatives", () => {
    expect(parseWatchdogIntervalMinutes("off")).toBe(null);
    expect(parseWatchdogIntervalMinutes("OFF")).toBe(null);
    expect(parseWatchdogIntervalMinutes("0")).toBe(null);
    expect(parseWatchdogIntervalMinutes("-3")).toBe(null);
  });

  it("falls back to the default on garbage and clamps tiny values", () => {
    expect(parseWatchdogIntervalMinutes("abc")).toBe(5);
    expect(parseWatchdogIntervalMinutes("5m")).toBe(5);
    expect(parseWatchdogIntervalMinutes("0.01")).toBe(0.25);
  });
});

describe("settings modal interval cycler", () => {
  const FLAGS_STUB = [
    { name: "agentmemory-autostart", label: "Auto-start server", description: "d1" },
    { name: "agentmemory-watchdog", label: "Background health watchdog", description: "d2" },
  ];
  it("builds an on/off row per flag plus an interval cycler row", () => {
    const rows = buildSettingsRows(FLAGS_STUB, (n) => n === "agentmemory-watchdog", "5");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: "agentmemory-autostart",
      currentValue: "off",
      values: ["on", "off"],
    });
    expect(rows[1]).toMatchObject({
      id: "agentmemory-watchdog",
      currentValue: "on",
      values: ["on", "off"],
    });
    expect(rows[2]).toMatchObject({
      id: "agentmemory-watchdog-interval",
      label: "Watchdog interval",
      currentValue: "5",
      values: ["5", "10", "30", "off"],
    });
  });
  it("shows the live interval value, including non-preset ones", () => {
    const rows = buildSettingsRows(FLAGS_STUB, () => false, "0.5");
    expect(rows[2]?.currentValue).toBe("0.5");
  });
  it("maps menu values to staged booleans or raw strings", () => {
    expect(stageMenuValue("on")).toBe(true);
    expect(stageMenuValue("off")).toBe(false);
    expect(stageMenuValue("10")).toBe("10");
  });
  it("drops net-zero flips and keeps genuine deltas", () => {
    const getFlag = (n: string) =>
      n === "agentmemory-watchdog" ? true : n === "agentmemory-watchdog-interval" ? "5" : undefined;
    const deltas = selectStagedDeltas(
      [
        ["agentmemory-watchdog", true], // staged on, already on: net zero
        ["agentmemory-watchdog-interval", "5"], // unchanged
        ["agentmemory-autostart", false], // default-off toggled off again
        ["agentmemory-watchdog-interval", "30"], // genuine change
        ["agentmemory-autostart", true], // genuine flip on
      ],
      getFlag,
    );
    expect(deltas).toEqual([
      ["agentmemory-watchdog-interval", "30"],
      ["agentmemory-autostart", true],
    ]);
  });
});

describe("background health watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeFakePi(flags: Record<string, boolean | string> = {}) {
    const handlers: Record<string, any> = {};
    const registeredFlags: Array<{ name: string; options: any }> = [];
    const setStatus = vi.fn();
    const pi: any = new Proxy(
      {
        registerTool: () => {},
        registerCommand: () => {},
        registerFlag: (name: string, options: any) =>
          void registeredFlags.push({ name, options }),
        getFlag: (name: string) => flags[name],
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
    return { pi, handlers, setStatus, registeredFlags };
  }

  const SESSION_CTX = (setStatus: any) => ({
    sessionManager: { getSessionFile: () => "/tmp/session.json" },
    ui: { setStatus },
  });

  // Stateful probe mock: the watchdog flips server state over time, so
  // routes answer from mutable flags instead of a fixed response queue.
  let healthFail: boolean;
  let livezUp: boolean;
  let fetchMock: any;

  function stubProbes() {
    fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/agentmemory/health")) {
        if (healthFail) throw new Error("ECONNREFUSED");
        return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
      }
      if (u.endsWith("/agentmemory/livez")) {
        if (!livezUp) throw new Error("ECONNREFUSED");
        return new Response("ok", { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  const healthCalls = () =>
    fetchMock.mock.calls.filter((c: unknown[]) =>
      String(c[0]).endsWith("/agentmemory/health"),
    ).length;

  const START = { agentmemory: false } as const;

  it("registers the watchdog flags with the right types", async () => {
    const { pi, registeredFlags } = makeFakePi();
    await factory(pi);
    const wd = registeredFlags.find((f) => f.name === "agentmemory-watchdog");
    const iv = registeredFlags.find(
      (f) => f.name === "agentmemory-watchdog-interval",
    );
    expect(wd?.options).toMatchObject({ type: "boolean" });
    expect(iv?.options).toMatchObject({ type: "string", default: "5" });
  });

  it("polls health in the background and keeps the chip fresh", async () => {
    const { pi, handlers, setStatus } = makeFakePi(START);
    healthFail = false;
    livezUp = true;
    stubProbes();
    await factory(pi);
    await handlers.session_start({}, SESSION_CTX(setStatus));
    expect(setStatus).toHaveBeenCalledWith("agentmemory", "🧠");
    const before = healthCalls();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(healthCalls()).toBeGreaterThan(before);
  });

  it("self-heals the chip from × to 🧠 on a later tick", async () => {
    const { pi, handlers, setStatus } = makeFakePi(START);
    healthFail = true;
    livezUp = false;
    stubProbes();
    await factory(pi);
    await handlers.session_start({}, SESSION_CTX(setStatus));
    expect(setStatus).toHaveBeenLastCalledWith("agentmemory", "🧠 ×");
    healthFail = false;
    livezUp = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(setStatus).toHaveBeenLastCalledWith("agentmemory", "🧠");
  });

  it("honors a custom 10-minute interval", async () => {
    const { pi, handlers, setStatus } = makeFakePi({
      ...START,
      "agentmemory-watchdog-interval": "10",
    });
    healthFail = false;
    livezUp = true;
    stubProbes();
    await factory(pi);
    await handlers.session_start({}, SESSION_CTX(setStatus));
    const before = healthCalls();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(healthCalls()).toBe(before);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(healthCalls()).toBeGreaterThan(before);
  });

  it("a stale slow probe never overwrites a newer healthy status", async () => {
    const { pi, handlers, setStatus } = makeFakePi(START);
    let healthN = 0;
    let staleSettled = false;
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.endsWith("/agentmemory/health")) {
          healthN++;
          if (healthN === 2) {
            // Watchdog tick probe hangs, then fails after a newer probe won.
            await probeGate;
            staleSettled = true;
            throw new Error("timeout");
          }
          return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
        }
        if (u.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
    await factory(pi);
    await handlers.session_start({}, SESSION_CTX(setStatus));
    expect(setStatus).toHaveBeenLastCalledWith("agentmemory", "🧠");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await handlers.before_agent_start(
      { systemPromptOptions: { cwd: "/tmp" }, messageType: "user", prompt: "", systemPrompt: "" },
      { ui: { setStatus } },
    );
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith("agentmemory", "🧠"));
    releaseProbe();
    await vi.waitFor(() => expect(staleSettled).toBe(true));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith("agentmemory", "🧠"));
  });

  it("does not poll when agentmemory-watchdog is false", async () => {
    const { pi, handlers, setStatus } = makeFakePi({
      ...START,
      "agentmemory-watchdog": false,
    });
    healthFail = false;
    livezUp = true;
    stubProbes();
    await factory(pi);
    await handlers.session_start({}, SESSION_CTX(setStatus));
    const before = healthCalls();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(healthCalls()).toBe(before);
  });

  it("does not poll when the interval is off", async () => {
    const { pi, handlers, setStatus } = makeFakePi({
      ...START,
      "agentmemory-watchdog-interval": "off",
    });
    healthFail = false;
    livezUp = true;
    stubProbes();
    await factory(pi);
    await handlers.session_start({}, SESSION_CTX(setStatus));
    const before = healthCalls();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(healthCalls()).toBe(before);
  });

  it("stops polling after a session reload", async () => {
    const { pi, handlers, setStatus } = makeFakePi(START);
    healthFail = false;
    livezUp = true;
    stubProbes();
    await factory(pi);
    await handlers.session_start({}, SESSION_CTX(setStatus));
    await handlers.session_shutdown({ reason: "reload" });
    const before = healthCalls();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(healthCalls()).toBe(before);
  });
});
