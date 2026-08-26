import { getSettingsListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import path from "node:path";
import crypto from "node:crypto";
import {
  guardPlaintextBearerAuth,
  setPlaintextBearerAuthNotifySink,
  resetPlaintextBearerAuthWarning,
} from "./security.js";
import { ensureServer } from "./server.js";
import { loadFlagSettings, saveFlagSetting } from "./flag-settings.js";

type TextBlock = { type?: string; text?: string };
type AssistantMessage = { role?: string; content?: unknown };

type SmartSearchResult = {
  title?: string;
  narrative?: string;
  type?: string;
  combinedScore?: number;
  score?: number;
  observation?: {
    title?: string;
    narrative?: string;
    type?: string;
  };
};

type HealthResponse = {
  status?: string;
  service?: string;
  version?: string;
  health?: {
    status?: string;
    notes?: string[];
  };
};

// Classify a health response. `degraded` is operational (server up,
// reads/writes work) just not pristine — treat as on, not off.
type HealthClass = "healthy" | "degraded" | "unhealthy" | "unknown";

function classifyHealth(health: HealthResponse | null): HealthClass {
  if (!health) return "unhealthy";
  const status = health.status || health.health?.status;
  if (status === "healthy") return "healthy";
  if (status === "degraded") return "degraded";
  if (status) return "unhealthy";
  return "unknown";
}

const DEFAULT_URL = process.env.AGENTMEMORY_URL || "http://localhost:3111";

// User-facing flags. Single source of truth — drives registerFlag, the
// /agentmemory status display, autocomplete, and the toggle subcommand.
// Auto-start is OPT-IN (default false): spawning a detached server (and
// possibly an `npx` download) on every session hangs agent startup on
// slower machines. Users enable it via `/agentmemory` or `pi config`.
const FLAGS = [
  {
    name: "agentmemory-autostart",
    label: "Auto-start server",
    description:
      "Start the local agentmemory server automatically when a session starts or a memory tool runs, if it is installed (or via npx when agentmemory-npx-fallback is on). Off by default — enable if your machine starts the server quickly.",
  },
  {
    name: "agentmemory-npx-fallback",
    label: "npx fallback",
    description:
      "If the agentmemory CLI is not on PATH, start it via `npx -y @agentmemory/agentmemory@latest`. Disable to only start a globally-installed server (and otherwise report that it is not installed).",
  },
] as const;

const TOOL_GUIDANCE = [
  "agentmemory is available for cross-session memory.",
  "Use memory_search to recall prior decisions, preferences, bugs, and workflows.",
  "Use memory_save when you discover durable facts worth remembering beyond this session.",
].join(" ");

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function getText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [] as string[];
      const block = part as TextBlock;
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      return [] as string[];
    })
    .join("\n")
    .trim();
}

function getLastAssistantText(messages: unknown[]): string {
  for (const msg of [...messages].reverse()) {
    if (!msg || typeof msg !== "object") continue;
    const assistant = msg as AssistantMessage;
    if (assistant.role !== "assistant") continue;
    const text = getText(assistant.content);
    if (text) return text;
  }
  return "";
}

function formatSearchResults(results: SmartSearchResult[]): string {
  if (!results.length) return "No relevant memories found.";
  return results
    .slice(0, 5)
    .map((result, index) => {
      const obs = result.observation ?? result;
      const title = obs.title?.trim() || `Memory ${index + 1}`;
      const narrative = obs.narrative?.trim() || "";
      const type = obs.type?.trim() || "memory";
      const score = result.combinedScore ?? result.score;
      const scoreText =
        typeof score === "number" ? ` [score=${score.toFixed(3)}]` : "";
      return `- ${title} (${type})${scoreText}${narrative ? `: ${narrative}` : ""}`;
    })
    .join("\n");
}

async function callAgentMemory<T>(
  pathname: string,
  options?: {
    method?: "GET" | "POST";
    body?: unknown;
    baseUrl?: string;
  },
): Promise<T | null> {
  const baseUrl = normalizeBaseUrl(
    options?.baseUrl || process.env.AGENTMEMORY_URL || DEFAULT_URL,
  );
  const method = options?.method || "POST";
  const url = `${baseUrl}/agentmemory/${pathname.replace(/^\/+/, "")}`;
  const headers: Record<string, string> = {};
  const secret = process.env.AGENTMEMORY_SECRET;

  guardPlaintextBearerAuth(baseUrl, secret);

  if (options?.body !== undefined) headers["Content-Type"] = "application/json";
  if (secret) headers.Authorization = `Bearer ${secret}`;

  try {
    const response = await fetch(url, {
      method,
      headers,
      body:
        options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export default function agentmemoryExtension(pi: ExtensionAPI) {
  if (process.env.AGENTMEMORY_REQUIRE_HTTPS === "1") {
    guardPlaintextBearerAuth(
      normalizeBaseUrl(process.env.AGENTMEMORY_URL || DEFAULT_URL),
      process.env.AGENTMEMORY_SECRET,
    );
  }

  // Register Pi-idiomatic flags at factory load time, NOT inside
  // session_start. registerFlag is static setup; calling it per session
  // would clobber user preferences on every /new or /reload. Defaults are
  // seeded from the persisted settings file (<piDir>/pi-agentmemory.json)
  // when it has an explicit boolean for a flag, so toggles survive a pi
  // restart; otherwise the in-code default below applies. Reloading the
  // session re-runs this factory and re-seeds, which is how a toggle applies.
  const persisted = loadFlagSettings();
  for (const f of FLAGS) {
    const stored = persisted[f.name];
    pi.registerFlag(f.name, {
      description: f.description,
      type: "boolean",
      default:
        typeof stored === "boolean" ? stored : f.name === "agentmemory-npx-fallback",
    });
  }

  let autoStartedNotified = false;
  function ensureOpts() {
    return {
      baseUrl: normalizeBaseUrl(process.env.AGENTMEMORY_URL || DEFAULT_URL),
      secret: process.env.AGENTMEMORY_SECRET,
      autostart: pi.getFlag("agentmemory-autostart") !== false,
      npxFallback: pi.getFlag("agentmemory-npx-fallback") !== false,
    };
  }

  let sessionId = `ephemeral-${crypto.randomUUID().slice(0, 8)}`;
  let currentProject = process.cwd();
  let lastPrompt = "";
  let lastHealthOk = false;
  let pendingSearch: Promise<string> | null = null;

  async function getHealth() {
    return await callAgentMemory<HealthResponse>("health", {
      method: "GET",
    });
  }

  async function refreshStatus(ctx: {
    ui: { setStatus: (key: string, text: string) => void };
  }) {
    const health = await getHealth();
    const cls = classifyHealth(health);
    // Healthy OR degraded = operational; anything else = off.
    lastHealthOk = cls === "healthy" || cls === "degraded";
    const label =
      cls === "healthy"
        ? "🧠 agentmemory"
        : cls === "degraded"
          ? "🧠 agentmemory~"
          : "🧠 agentmemory off";
    ctx.ui.setStatus("agentmemory", label);
  }

  // Build the /agentmemory status panel. Read-only snapshot of server
  // health and the on/off state of every flag. `health` is fetched by the
  // caller (async) and threaded in so this stays sync like the glm-tweaks
  // reference.
  function renderStatus(health: HealthResponse | null): string {
    const statusWord = health?.status || health?.health?.status || "unknown";
    const healthLine = health
      ? `${statusWord}${health.version ? ` v${health.version}` : ""}`
      : "unreachable at http://localhost:3111";
    const flagLines = FLAGS.map(
      (f) => `  ${pi.getFlag(f.name) === true ? "[x]" : "[ ]"} ${f.name}`,
    );
    return [
      `agentmemory — server: ${healthLine}`,
      "",
      "flags:",
      ...flagLines,
      "",
      "toggle: /agentmemory toggle <flag>   (shorthand: /agentmemory <flag>)",
    ].join("\n");
  }

  // /agentmemory — status display by default; `toggle <flag>` (or bare
  // `<flag>`) flips a boolean. ExtensionAPI exposes no live setFlag, so a
  // toggle writes through to <piDir>/pi-agentmemory.json and then reloads
  // the session so the in-memory flag value picks up the change. ctx is
  // stale after reload() — we notify first, reload last, and return
  // immediately.
  pi.registerCommand("agentmemory", {
    description:
      "agentmemory: show server health + flags, or toggle a flag. Usage: /agentmemory [toggle <flag>]",
    getArgumentCompletions: (prefix: string) => {
      // Preserve trailing space: `/agentmemory toggle ` (with space) means
      // the `toggle` token is complete and we should now suggest flags.
      // Trimming would collapse it to "toggle" and re-suggest the word.
      const trailingSpace = /\s$/.test(prefix);
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      const flagNames = FLAGS.map((f) => f.name);
      const root = ["toggle", "status", ...flagNames];
      // Suggest flag names once `toggle` is complete (either as the only
      // token with a trailing space, or with a partial flag typed).
      const toggleComplete =
        (tokens.length === 1 && tokens[0] === "toggle") ||
        (tokens.length >= 2 && tokens[0] === "toggle");
      if (toggleComplete) {
        const partial = tokens.length >= 2 ? tokens[tokens.length - 1] : "";
        const hits = flagNames.filter((n) => n.startsWith(partial));
        return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
      }
      if (tokens.length <= 1 && !trailingSpace) {
        const hits = root.filter((o) => o.startsWith(tokens[0] ?? ""));
        return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
      }
      return null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // Toggle mode: `/agentmemory toggle <flag>` or `/agentmemory <flag>`.
      // Direct one-shot flip — persists to the settings file then reloads.
      // Bare `/agentmemory toggle` (no flag) and `/agentmemory status`
      // fall through to the menu.
      if (
        trimmed !== "" &&
        trimmed !== "status" &&
        trimmed !== "toggle"
      ) {
        const tokens = trimmed.split(/\s+/).filter(Boolean);
        const flagName = tokens[0] === "toggle" ? tokens[1] : tokens[0];
        const meta = FLAGS.find((f) => f.name === flagName);
        if (!meta) {
          ctx.ui.notify(
            `Unknown flag "${flagName}". Valid: ${FLAGS.map((f) => f.name).join(", ")}`,
            "warning",
          );
          return;
        }
        const current = pi.getFlag(meta.name) === true;
        const next = !current;
        if (!saveFlagSetting(meta.name, next)) {
          ctx.ui.notify(
            `Failed to persist ${meta.name} (disk write failed).`,
            "error",
          );
          return;
        }
        ctx.ui.notify(`${meta.name}: ${current} → ${next}. Reloading...`, "info");
        await ctx.reload();
        return;
      }

      // Status/menu mode. Fetch health once up front (both the non-TUI
      // panel and the TUI header reuse it).
      const health = await getHealth();

      // Outside TUI (RPC/headless), fall back to the read-only status
      // panel — custom components are terminal-only.
      if (ctx.mode !== "tui") {
        ctx.ui.notify(renderStatus(health), "info");
        return;
      }

      const pending = new Map<string, boolean>();
      const items: SettingItem[] = FLAGS.map((f) => ({
        id: f.name,
        label: f.label,
        description: f.description,
        currentValue: pi.getFlag(f.name) === true ? "on" : "off",
        values: ["on", "off"],
      }));

      const healthText = health
        ? `${health.status || health.health?.status || "unknown"}${health.version ? ` v${health.version}` : ""}`
        : "unreachable";

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(
          new Text(theme.fg("accent", `agentmemory — server: ${healthText}`), 1, 1),
        );

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            // Stage the change; persist + reload on close, not here,
            // so the user can flip several flags per visit.
            pending.set(id, newValue === "on");
          },
          () => done(undefined),
        );
        container.addChild(settingsList);

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });

      // Dialog closed. ctx is still valid here (reload is the only
      // staleness trigger, and we haven't called it yet). Drop net-zero
      // flips (a flag toggled on then off stages but changes nothing),
      // then persist genuine deltas and reload once if any moved.
      const deltas: Array<[string, boolean]> = [];
      for (const [name, val] of pending) {
        const currentlyOn = pi.getFlag(name) === true;
        if (currentlyOn === val) continue; // net-zero: toggled back to current
        deltas.push([name, val]);
      }
      if (deltas.length === 0) return;

      const failures: string[] = [];
      for (const [name, val] of deltas) {
        if (!saveFlagSetting(name, val)) failures.push(name);
      }
      if (failures.length > 0) {
        ctx.ui.notify(`Failed to apply: ${failures.join("; ")}`, "error");
        return;
      }
      ctx.ui.notify(`Applied ${deltas.length} change(s). Reloading...`, "info");
      await ctx.reload();
    },
  });

  // Tool: memory_health
  pi.registerTool({
    name: "memory_health",
    label: "Memory Health",
    description:
      "Check whether the local agentmemory server is reachable and healthy",
    parameters: Type.Object({}),
    async execute() {
      const health = await getHealth();
      if (!health) {
        return {
          content: [
            {
              type: "text",
              text: "agentmemory is unreachable at http://localhost:3111",
            },
          ],
          details: { ok: false },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `agentmemory status: ${health.status || health.health?.status || "unknown"}${health.version ? ` (v${health.version})` : ""}`,
          },
        ],
        details: { ...health, ok: true },
      };
    },
    renderResult(result, _renderState, theme) {
      const details = result.details as
        | (HealthResponse & { ok?: boolean })
        | undefined;
      if (!details || details.ok === false)
        return new Text(theme.fg("error", "● agentmemory unreachable"), 0, 0);
      const status = details.status || details.health?.status || "unknown";
      const version = details.version ? ` v${details.version}` : "";
      if (status === "healthy")
        return new Text(
          theme.fg("success", `● agentmemory healthy${version}`),
          0,
          0,
        );
      return new Text(
        theme.fg("warning", `● agentmemory ${status}${version}`),
        0,
        0,
      );
    },
  });

  // Tool: memory_search
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search agentmemory for cross-session project memory, prior decisions, bugs, and user preferences",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for in memory" }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          default: 5,
          description: "Maximum results",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const ensured = await ensureServer(ensureOpts());
      if (!ensured.ok) {
        return {
          content: [{ type: "text", text: ensured.reason }],
          details: { ok: false, query: params.query, results: [] },
        };
      }
      // `search` returns full observations (title + narrative).
      // `smart-search` returns title-only "compact" results by design (no
      // narrative field), which left agents with ~80-char title fragments
      // and no body — see CHANGELOG 1.0.10.
      const result = await callAgentMemory<{ results?: SmartSearchResult[] }>(
        "search",
        { body: { query: params.query, limit: params.limit ?? 5 } },
      );
      const results = result?.results || [];
      return {
        content: [{ type: "text", text: formatSearchResults(results) }],
        details: { ok: true, query: params.query, results },
      };
    },
  });

  // Tool: memory_save
  pi.registerTool({
    name: "memory_save",
    label: "Memory Save",
    description:
      "Save a durable fact, convention, workflow, preference, or bug fix into agentmemory",
    parameters: Type.Object({
      content: Type.String({ description: "What should be remembered" }),
      type: Type.Optional(
        Type.String({ description: "Memory type", default: "fact" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const ensured = await ensureServer(ensureOpts());
      if (!ensured.ok) {
        return {
          content: [{ type: "text", text: ensured.reason }],
          details: { ok: false },
        };
      }
      const result = await callAgentMemory<Record<string, unknown>>(
        "remember",
        { body: { content: params.content, type: params.type || "fact" } },
      );
      if (!result) {
        return {
          content: [
            { type: "text", text: "Failed to save memory to agentmemory." },
          ],
          details: { ok: false },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Saved memory (${params.type || "fact"}): ${params.content}`,
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory_delete",
    label: "Memory Delete",
    description:
      "Permanently delete a memory, an entire session (+ its observations), or specific observations from agentmemory. HARD CONFIRMATION REQUIRED: shows the human exactly what will be removed and blocks until they approve. Never use for bulk pruning (consolidation handles that); reserve for privacy removal or correcting wrong info.",
    promptSnippet:
      "memory_delete removes a memory/session/observations from agentmemory. It ALWAYS prompts the human for explicit confirmation first; never call it speculatively.",
    promptGuidelines: [
      "memory_delete is destructive and always prompts the human. Requires the user to name the specific item to delete in THIS turn — do not infer deletion intent from earlier instructions. Never use it for bulk cleanup (consolidation owns that). If you need observation IDs, call memory_search first; do not fall back to deleting a whole session when specific observations were requested.",
    ],
    parameters: Type.Object({
      id: Type.String({
        description:
          "The ID to delete: a memoryId (kind=memory), a sessionId (kind=session), or an observation's sessionId (kind=observations)",
      }),
      kind: Type.Union(
        [
          Type.Literal("memory"),
          Type.Literal("session"),
          Type.Literal("observations"),
        ],
        { description: "What 'id' refers to: a memory, a whole session, or observations within a session" },
      ),
      observationIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Required when kind=observations: specific observation IDs within the session to delete. Omit for kind=memory or kind=session.",
        }),
      ),
      reason: Type.Optional(
        Type.String({ description: "Short reason for the audit trail" }),
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ensured = await ensureServer(ensureOpts());
      if (!ensured.ok) {
        return {
          content: [{ type: "text", text: ensured.reason }],
          details: { ok: false },
        };
      }

      // Cross-field guard: the TypeBox schema can't express 'observationIds
      // required when kind=observations'. Without this, an empty/missing list
      // would build a {sessionId} body that the engine treats as delete-whole-
      // session — wiping far more than the agent asked for.
      if (params.kind === "observations" && !params.observationIds?.length) {
        return {
          content: [
            {
              type: "text",
              text: "kind=observations requires a non-empty observationIds list. Aborted before any deletion.",
            },
          ],
          details: { ok: false, reason: "missing observationIds" },
        };
      }

      // Agent-controlled strings flow into the confirm dialog the human reads.
      // Strip line/control chars so an agent can't inject fake preview lines
      // (e.g. an id containing \n to fabricate extra observation entries).
      const sanitize = (s: string): string => s.replace(/[\r\n\t]/g, " ");

      // Build a human-readable preview of exactly what dies, so the
      // confirmation dialog is informative. Lookups are best-effort: if the
      // engine is unreachable or the ID is malformed, we still show the raw id
      // and let the human decide. NOTE: sessions list is capped at 500; beyond
      // that the preview degrades to 'details unavailable' rather than delete blind.
      let previewLines: string[];
      if (params.kind === "memory") {
        previewLines = [`1 memory: ${sanitize(params.id)}`];
      } else if (params.kind === "session") {
        const sessions = await callAgentMemory<{ sessions?: Array<{ id: string; cwd?: string; observationCount?: number }> }>(
          `sessions?limit=500`,
          { method: "GET" },
        );
        const match = sessions?.sessions?.find((s) => s.id === params.id);
        previewLines = match
          ? [
              `Session ${params.id}`,
              `  cwd: ${match.cwd ?? "(unknown)"}`,
              `  observations: ${match.observationCount ?? "(unknown)"}`,
              `Deletes the session record, its summary, and ALL its observations.`,
            ]
          : [`Session ${params.id} (details unavailable; will attempt deletion)`];
      } else {
        // kind=observations (guarded above to have a non-empty list)
        previewLines = [
          `${params.observationIds?.length ?? 0} observation(s) in session ${sanitize(params.id)}`,
          ...(params.observationIds ?? []).map((o) => `  - ${sanitize(o)}`),
        ];
      }

      // HARD GATE: blocks tool execution until the human answers in the TUI.
      // In headless/RPC mode ui.confirm has no TUI and resolves false, so
      // unattended agents cannot delete — by design.
      const confirmed = await ctx.ui.confirm(
        "Delete from agentmemory?",
        [
          "This is permanent and audited. Confirm only if you initiated this.",
          "",
          ...previewLines,
          "",
          `reason: ${sanitize(params.reason ?? "(none given)")}`,
        ].join("\n"),
      );
      if (!confirmed) {
        return {
          content: [
            {
              type: "text",
              text: "Deletion cancelled by the human. Memory left untouched.",
            },
          ],
          details: { ok: false, cancelled: true },
        };
      }

      // Map to the REST mem::forget function — the only path that correctly
      // handles memories, sessions, AND observations on engine 0.9.27.
      // (The memory_governance_delete MCP tool silently no-ops on observations.)
      const body: Record<string, unknown> = { reason: params.reason ?? "pi memory_delete" };
      if (params.kind === "memory") body.memoryId = params.id;
      else {
        body.sessionId = params.id;
        if (params.kind === "observations" && params.observationIds?.length) {
          body.observationIds = params.observationIds;
        }
      }
      const result = await callAgentMemory<{ deleted?: number; success?: boolean }>(
        "forget",
        { body },
      );
      if (!result) {
        return {
          content: [
            { type: "text", text: "Forget call failed (engine unreachable or refused)." },
          ],
          details: { ok: false },
        };
      }
      // Engine reports success even on phantom deletes (upstream #833), so
      // surface a 0-count explicitly rather than letting the agent believe a
      // non-existent ID was removed.
      const removedCount = result.deleted ?? 0;
      const what =
        params.kind === "memory" ? "memory"
        : params.kind === "session" ? "session (record, summary, observations)"
        : `${params.observationIds?.length ?? 0} observation(s)`;
      const text = removedCount === 0
        ? `Delete reported success but the engine removed 0 records for ${what}. The ID may not exist (upstream #833). Nothing was changed.`
        : `Deleted ${what} from agentmemory. Engine removed ${removedCount} record(s).`;
      return {
        content: [{ type: "text", text }],
        details: { ok: removedCount > 0, kind: params.kind, id: params.id, engine: result },
      };
    },
  });

  // Hook: session_start
  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    sessionId = sessionFile
      ? path.basename(sessionFile).replace(/\.[^.]+$/, "")
      : `ephemeral-${crypto.randomUUID().slice(0, 8)}`;
    currentProject = process.cwd();
    // Kick the server start off in the background so a cold start (engine
    // download, ~15s) never stalls the session. refreshStatus below does a quick
    // health check; tools and before_agent_start await the shared attempt if
    // they need the server. Snapshot ui for the fire-and-forget callback.
    const { ui } = ctx;
    // Route the plaintext-HTTP bearer warning through ui.notify (an ephemeral
    // toast) instead of console.warn (stderr, which pi's TUI pins above the
    // input for the whole session). Re-arm the per-session dedupe so each
    // session can surface the warning once. Must run before ensureServer and
    // refreshStatus: their health checks are the first calls to trip the guard,
    // and both index.ts and server.ts share the singleton, so this collapses
    // the previous double warning into a single toast.
    setPlaintextBearerAuthNotifySink((msg, level) => ui.notify(msg, level));
    resetPlaintextBearerAuthWarning();
    void ensureServer(ensureOpts())
      .then((ensured) => {
        if (ensured.ok && ensured.started && !autoStartedNotified) {
          autoStartedNotified = true;
          ui.notify("agentmemory server started automatically.", "info");
        }
      })
      .catch(() => {
        /* best-effort; tools retry on demand */
      });
    await refreshStatus(ctx);
  });

  // Hook: before_agent_start (start search, return immediately)
  pi.on("before_agent_start", async (event, ctx) => {
    currentProject = event.systemPromptOptions.cwd || process.cwd();
    lastPrompt = event.prompt?.trim() || "";
    pendingSearch = null;

    if (lastPrompt) {
      pendingSearch = (async () => {
        // `search`, not `smart-search`: full narratives in the injected
        // recall block, same rationale as memory_search above.
        const result = await callAgentMemory<{ results?: SmartSearchResult[] }>(
          "search",
          { body: { query: lastPrompt, limit: 5 } },
        );
        const results = result?.results || [];
        return results.length
          ? ["Relevant long-term memory from agentmemory:", formatSearchResults(results)].join("\n")
          : "";
      })();
    }

    // Snapshot ui to avoid ctx lifetime issues during fire-and-forget
    const { ui } = ctx;
    void refreshStatus({ ui });
    return {
      systemPrompt: [event.systemPrompt, TOOL_GUIDANCE]
        .filter(Boolean)
        .join("\n\n"),
    };
  });

  // Hook: context (inject search results before first LLM call)
  pi.on("context", async (event) => {
    if (!pendingSearch) return;
    const search = pendingSearch;
    pendingSearch = null;

    const recallBlock = await search;
    if (!recallBlock) return;

    return {
      messages: [
        { role: "user", content: [{ type: "text", text: recallBlock }] } as never,
        ...event.messages,
      ],
    };
  });

  // Hook: agent_end (observe)
  pi.on("agent_end", async (event) => {
    if (!lastHealthOk || !lastPrompt) return;
    const assistantText = getLastAssistantText(event.messages as unknown[]);
    if (!assistantText) return;
    void callAgentMemory("observe", {
      body: {
        hookType: "post_tool_use",
        sessionId,
        project: currentProject,
        cwd: currentProject,
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "conversation",
          tool_input: lastPrompt.slice(0, 500),
          tool_output: assistantText.slice(0, 4000),
        },
      },
    });
  });
}
