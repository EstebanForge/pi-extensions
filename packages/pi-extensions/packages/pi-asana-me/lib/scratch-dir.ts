// Per-process scratch directory for downloaded attachments.
//
// Why this exists: asana_download_attachment writes files to disk (XLS / CSV /
// images / ...) so the agent can `read` or parse them. The agent does not know
// when it is "done" with a file, so per-file cleanup is the wrong model - it
// would have to track and delete each one, which it cannot do reliably. Instead
// we give the whole process ONE temp dir, created lazily on first download and
// wiped when the process ends. The agent reads the file, acts on it, and
// forgets it. No cleanup routine needed.
//
// Portability: the dir lives under os.tmpdir(), which resolves per platform:
//   Linux  -> /tmp                                   (world-writable, OS-reaped)
//   macOS  -> /var/folders/<hash>/T/                 (per-user sandbox temp;
//                                                      /tmp is NOT the right
//                                                      base on macOS)
//   Windows-> %LOCALAPPDIR%\Temp
//
// Cleanup hooks: the primary path is the `exit` listener (runs on
// process.exit() and uncaught exceptions). On signals that bypass `exit` by
// default (SIGINT/SIGTERM/SIGHUP/SIGBREAK - i.e. Ctrl-C / kill), we also
// register listeners that run the same idempotent rmSync and then re-raise the
// signal (remove our own listener, re-send) so pi's own signal handling stays
// in control and we do NOT short-circuit it with process.exit(). os.tmpdir()'s
// own OS-level reaping is the fallback for SIGKILL / power loss, which no
// listener can catch.
//
// Concurrency: a monotonic generation counter scopes the "reset won the race
// while mkdtemp was in flight" case. If mkdtemp resolves and finds its
// generation is stale (a reset happened during it), it cleans the stray dir
// and RECURSES into getScratchDir so the caller receives a live,
// listener-backed dir rather than a deleted path.

import { promises as fs, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const PREFIX = "pi-asana-me-";
// Signals whose default disposition terminates without emitting `exit`, so a
// plain `exit` listener would never fire on them. We wire each to the same
// cleanup + re-raise. SIGBREAK is Windows-only and is a no-op to register
// elsewhere.
const CLEANUP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];

// `dir` holds the resolved path once creation finishes; `dirPromise` is the
// cached in-flight creation so concurrent callers await the same mkdtemp.
// `generation` is bumped on every _resetScratch so an in-flight mkdtemp can
// detect it was superseded and self-clean. `exitListener` and
// `signalHandlers` are tracked so _resetScratch can detach ALL of them (not
// just the exit listener) - otherwise test loops leak one handler set per
// getScratchDir call, and a production reset would leave stale signal
// handlers wiping an already-gone dir.
let dir: string | undefined;
let dirPromise: Promise<string> | undefined;
let exitListener: (() => void) | undefined;
const signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
let generation = 0;

// The single cleanup op. Idempotent + best-effort so it is safe to call from
// the exit listener, from each signal handler, and from _resetScratch.
function wipe(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // Swallow: exit / signal cleanup is best-effort. OS tmp reaping covers leaks.
  }
}

// Lazily create and cache the per-process scratch dir. Idempotent: repeated
// calls return the same dir.
export function getScratchDir(): Promise<string> {
  if (dirPromise) return dirPromise;
  const gen = ++generation;
  dirPromise = (async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), PREFIX));
    // A reset superseded this generation while mkdtemp was in flight. Clean
    // the stray dir and recurse so the caller gets a live, tracked dir
    // instead of `created` (which we just deleted).
    if (gen !== generation) {
      wipe(created);
      dirPromise = undefined;
      return getScratchDir();
    }
    dir = created;
    const listener = (): void => wipe(created);
    exitListener = listener;
    process.on("exit", listener);
    // Signal handlers: run the same wipe, then re-raise so Node's default
    // disposition (or pi's own handler) still applies. We remove ourselves
    // first to avoid recursion; if pi registered its own listeners they run
    // normally on the re-raised signal.
    for (const sig of CLEANUP_SIGNALS) {
      const handler = (): void => {
        wipe(created);
        process.removeListener(sig, handler);
        // Re-raise. If other listeners remain (pi's), they handle it; if none
        // remain, the default disposition terminates the process. Either way
        // our cleanup already ran.
        try {
          process.kill(process.pid, sig);
        } catch {
          // If re-raise fails (already exiting), fall through to process end.
        }
      };
      process.once(sig, handler);
      signalHandlers.push({ signal: sig, handler });
    }
    return created;
  })();
  return dirPromise;
}

// Test-only reset: removes the exit listener AND every signal handler,
// deletes the dir synchronously, bumps generation (so any in-flight mkdtemp
// self-cleans), and clears cached state so the next getScratchDir() creates a
// fresh one. Synchronous on purpose so a test's afterEach can guarantee
// teardown without an await dance.
export function _resetScratch(): void {
  if (exitListener) {
    process.off("exit", exitListener);
    exitListener = undefined;
  }
  for (const { signal, handler } of signalHandlers) {
    process.removeListener(signal, handler);
  }
  signalHandlers.length = 0;
  if (dir) {
    wipe(dir);
  }
  dir = undefined;
  generation++;
  dirPromise = undefined;
}
