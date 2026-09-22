import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// The scratch dir is per-process module state. Each test resets it in
// afterEach so the cached promise, exit listener, and signal handlers never
// leak between tests (and so the test process does not accumulate dirs /
// listeners across the suite).

// node:fs/promises has no pathExists (that is fs-extra). Thin helper so the
// assertions stay readable.
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Signals the scratch dir wires for cleanup + re-raise. Must mirror the module
// constant so listener-count assertions know how many each getScratchDir adds.
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];

// Snapshot how many listeners WE add, so the assertions are independent of
// whatever else (vitest, pi) has registered on the same events.
function ourListenerCount(): { exit: number; signals: number } {
  const exit = process.listenerCount("exit");
  const signals = CLEANUP_SIGNALS.reduce(
    (sum, s) => sum + process.listenerCount(s as NodeJS.Signals),
    0,
  );
  return { exit, signals };
}

beforeEach(async () => {
  // Ensure a clean baseline before each test: reset any dir/listeners a
  // previous test left behind. afterEach also resets, but this guards against
  // a test that throws mid-way.
  const { _resetScratch } = await import("../lib/scratch-dir");
  _resetScratch();
});

afterEach(async () => {
  const { _resetScratch } = await import("../lib/scratch-dir");
  _resetScratch();
});

describe("getScratchDir", () => {
  it("creates a dir under os.tmpdir() with the pi-asana-me prefix", async () => {
    const { getScratchDir } = await import("../lib/scratch-dir");
    const dir = await getScratchDir();
    expect(await pathExists(dir)).toBe(true);
    // Resolves per platform: /tmp on Linux, /var/folders/.../T on macOS,
    // %LOCALAPPDATA%/Temp on Windows. os.tmpdir() is the portable base.
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(dir).startsWith("pi-asana-me-")).toBe(true);
  });

  it("returns the SAME dir on repeat calls (no accumulation of dirs)", async () => {
    const { getScratchDir } = await import("../lib/scratch-dir");
    const a = await getScratchDir();
    // Second + concurrent calls share the cached promise (same dir, one
    // listener set), never each minting their own dir.
    const [b, c] = await Promise.all([getScratchDir(), getScratchDir()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("registers exactly one exit listener + one signal set per dir", async () => {
    const baseline = ourListenerCount();
    const { getScratchDir } = await import("../lib/scratch-dir");
    await getScratchDir();
    expect(ourListenerCount()).toEqual({
      exit: baseline.exit + 1,
      signals: baseline.signals + CLEANUP_SIGNALS.length,
    });
  });

  it("_resetScratch removes the exit listener, all signal handlers, and the dir", async () => {
    const baseline = ourListenerCount();
    const { getScratchDir, _resetScratch } = await import("../lib/scratch-dir");
    const dir = await getScratchDir();
    expect(await pathExists(dir)).toBe(true);

    _resetScratch();

    expect(ourListenerCount()).toEqual(baseline);
    expect(await pathExists(dir)).toBe(false);
  });

  it("creates a fresh dir after _resetScratch (the cache clears)", async () => {
    const { getScratchDir, _resetScratch } = await import("../lib/scratch-dir");
    const first = await getScratchDir();
    _resetScratch();
    const second = await getScratchDir();
    expect(second).not.toBe(first);
    expect(await pathExists(first)).toBe(false);
    expect(await pathExists(second)).toBe(true);
  });

  // The race the generation counter exists to close: _resetScratch fires
  // WHILE a mkdtemp is still in flight. With the old shared `cancelled`
  // boolean this interleaving leaked a second exit listener + an unreachable
  // dir; with the generation counter the stale mkdtemp self-cleans and the
  // caller ends up with exactly one live, listener-backed dir.
  it("does not leak a listener/dir when reset runs while mkdtemp is in flight", async () => {
    const baseline = ourListenerCount();
    const { getScratchDir, _resetScratch } = await import("../lib/scratch-dir");

    // Start creation, do NOT await: mkdtemp is now in flight.
    const p1 = getScratchDir();
    // Reset synchronously while mkdtemp is pending: bumps generation, clears
    // the cached promise.
    _resetScratch();
    // Now await p1: its IIFE sees a stale generation, wipes the stray dir it
    // just made, and recurses into getScratchDir to hand back a live dir.
    const resolved = await p1;

    // Exactly ONE dir's worth of listeners exist (not two).
    expect(ourListenerCount()).toEqual({
      exit: baseline.exit + 1,
      signals: baseline.signals + CLEANUP_SIGNALS.length,
    });
    expect(await pathExists(resolved)).toBe(true);
    // The resolved dir is the fresh, tracked one: another getScratchDir returns
    // the same dir (proving the recursion cached it, not a stray).
    const { getScratchDir: fresh } = await import("../lib/scratch-dir");
    expect(await fresh()).toBe(resolved);
  });

  it("the exit listener swallows rmSync failures (best-effort cleanup)", async () => {
    // Capture the actual registered exit listener and drive it directly with a
    // missing dir, so we prove the wipe() contract: never throws, even when the
    // target is already gone (process killing the temp dir out from under us).
    const { getScratchDir, _resetScratch } = await import("../lib/scratch-dir");
    const dir = await getScratchDir();
    await fs.rm(dir, { recursive: true, force: true });
    const exitListeners = process.listeners("exit");
    const ours = exitListeners[exitListeners.length - 1];
    expect(typeof ours).toBe("function");
    expect(() => (ours as () => void)()).not.toThrow();
    // _resetScratch after must also stay quiet (its own wipe(force:true)).
    expect(() => _resetScratch()).not.toThrow();
  });
});
