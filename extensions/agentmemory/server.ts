// server.ts — detect, start, and wait for the local agentmemory server.
//
// The server is a long-running process, spawned detached so it outlives Pi:
// closing Pi leaves it running, and reopening Pi detects it via the health
// check and does NOT start it again. First run downloads its engine (~15s).
//
// "Is it running?" is answered by the health endpoint (GET /agentmemory/health)
// — the same one the tools already use. We check it before starting and poll it
// after, so a server another Pi instance started, or one left running from a
// previous Pi, is never started twice. An in-flight dedup promise keeps a single
// Pi process from spawning more than once if several tools fire while it's down.
import { spawn } from "node:child_process";
import { guardPlaintextBearerAuth } from "./security.js";

const NPX_ARGS = ["-y", "@agentmemory/agentmemory@latest"];
const START_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;
const IS_WIN = process.platform === "win32";
const SPAWN_COOLDOWN_MS = 30_000;

let lastSpawnAt = 0;

export type EnsureOptions = {
  baseUrl: string;
  secret?: string;
  autostart: boolean;
  npxFallback: boolean;
  timeoutMs?: number;
};

export type EnsureResult =
  | { ok: true; started: boolean }
  | { ok: false; reason: string };

type StartAttempt = { up: boolean; installed: boolean; spawned: boolean };

let starting: Promise<StartAttempt> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function healthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/agentmemory/health`;
}

export async function isServerHealthy(
  baseUrl: string,
  secret?: string,
): Promise<boolean> {
  guardPlaintextBearerAuth(baseUrl, secret);
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  try {
    const res = await fetch(healthUrl(baseUrl), { method: "GET", headers });
    if (!res.ok) return false;
    const body = (await res.json()) as {
      status?: string;
      health?: { status?: string };
    };
    // The engine self-reports `degraded` under memory pressure (RSS watermark,
    // KV lag) while still serving reads/writes. Treat anything except an
    // explicit down/unhealthy as reachable so a pressured-but-working server
    // shared across Pi instances (host + construct sandbox) isn't misread as
    // down, which would trip the autostart-disabled bail path.
    const status = body.status ?? body.health?.status;
    return status !== "unhealthy" && status !== "down" && status !== undefined;
  } catch {
    return false;
  }
}

// Exit code of a short command (0 = success). Never throws.
function runShort(cmd: string, args: string[], timeoutMs = 5000): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: true,
      stdio: "ignore",
      env: { ...process.env, CI: "1" },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(124);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

export async function isCliInstalled(): Promise<boolean> {
  return (await runShort("agentmemory", ["--version"])) === 0;
}

function spawnServer(useNpx: boolean): void {
  const cmd = useNpx ? "npx" : "agentmemory";
  const args = useNpx ? NPX_ARGS : [];
  // detached + unref so the server survives Pi. No shell on POSIX (clean
  // daemonization); shell on Windows where the .cmd wrapper needs it.
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
    shell: IS_WIN,
    env: { ...process.env, CI: "1" },
  });
  child.on("error", () => {}); // a failed spawn just means waitForHealth times out
  child.unref();
}

async function waitForHealth(opts: EnsureOptions): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (await isServerHealthy(opts.baseUrl, opts.secret)) return true;
  }
  return false;
}

export async function ensureServer(opts: EnsureOptions): Promise<EnsureResult> {
  // Already running (a previous Pi left it up, or another instance started it):
  // detect via the health check and do nothing. This is the "don't restart"
  // guarantee for reopening Pi and for concurrent Pi instances.
  if (await isServerHealthy(opts.baseUrl, opts.secret)) {
    return { ok: true, started: false };
  }
  if (!opts.autostart) {
    return {
      ok: false,
      reason:
        "agentmemory server is not running and autostart is disabled (flag agentmemory-autostart=false). Start it manually with `agentmemory`.",
    };
  }

  // Dedup so concurrent tool calls in this Pi share one start attempt.
  if (!starting) {
    starting = (async (): Promise<StartAttempt> => {
      const installed = await isCliInstalled();
      if (!installed && !opts.npxFallback) {
        return { up: false, installed, spawned: false };
      }
      // Re-check right before spawning: another Pi may have just brought it up.
      if (await isServerHealthy(opts.baseUrl, opts.secret)) {
        return { up: true, installed, spawned: false };
      }
      // Cooldown: if we spawned very recently and it's still warming up, don't
      // spawn again — just wait for health. Avoids redundant spawns / npx
      // downloads on sequential retries after a timeout.
      const recentlySpawned = Date.now() - lastSpawnAt < SPAWN_COOLDOWN_MS;
      if (!recentlySpawned) {
        lastSpawnAt = Date.now();
        spawnServer(!installed);
      }
      return { up: await waitForHealth(opts), installed, spawned: !recentlySpawned };
    })().finally(() => {
      starting = null;
    });
  }
  const attempt = await starting;

  if (attempt.up) return { ok: true, started: attempt.spawned };
  if (!attempt.installed && !opts.npxFallback) {
    return {
      ok: false,
      reason:
        "agentmemory server not running and the CLI is not installed. Install: `npm i -g @agentmemory/agentmemory`, or enable flag agentmemory-npx-fallback. See https://www.agent-memory.dev",
    };
  }
  return {
    ok: false,
    reason: `agentmemory server did not become healthy within ${Math.round(
      (opts.timeoutMs ?? START_TIMEOUT_MS) / 1000,
    )}s. First run downloads its engine; retry shortly or run \`agentmemory --verbose\`.`,
  };
}
