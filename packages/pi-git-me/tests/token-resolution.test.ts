// Unit tests for ghAuthToken (lib/attachment-upload.ts): the GitHub bearer
// token resolution chain used by the attachment upload fetch. `node:child_process`
// is mocked (same pattern as comment-images.test.ts) so no test shells out to a
// real `gh`; process.env is snapshotted and restored around every case.
//
// Pinned contract: `gh auth token` is probed FIRST with the token env vars
// stripped from the child environment (so gh answers from its keyring and a
// stale GITHUB_TOKEN cannot shadow the login), then the env chain
// GITHUB_TOKEN -> GITHUB_PAT_TOKEN -> GH_PAT_TOKEN -> GH_TOKEN.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- child_process mock ------------------------------------------------------
const { cpMock } = vi.hoisted(() => {
  type FakeResult = { stdout: string; stderr: string; status: number };
  type Route = {
    match: (cmd: string, args: string[]) => boolean;
    result: () => FakeResult;
  };
  const state: {
    routes: Route[];
    calls: Array<{ cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }>;
  } = { routes: [], calls: [] };
  const spawnSyncMock = (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): FakeResult => {
    state.calls.push({ cmd, args: [...args], cwd: opts?.cwd, env: opts?.env });
    for (const route of state.routes) {
      if (route.match(cmd, args)) return route.result();
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  return { cpMock: { state, spawnSyncMock } };
});

vi.mock("node:child_process", () => ({
  spawnSync: cpMock.spawnSyncMock,
}));

import { ghAuthToken } from "../lib/attachment-upload";

const TOKEN_ENV_VARS = ["GITHUB_TOKEN", "GITHUB_PAT_TOKEN", "GH_PAT_TOKEN", "GH_TOKEN"];

function probeRoute(result: { stdout: string; stderr: string; status: number }) {
  cpMock.state.routes = [
    { match: (c, a) => c === "gh" && a[0] === "auth" && a[1] === "token", result: () => result },
  ];
}

function findProbeEnv(): NodeJS.ProcessEnv | undefined {
  return cpMock.state.calls.find(
    (c) => c.cmd === "gh" && c.args[0] === "auth" && c.args[1] === "token",
  )?.env;
}

let tempDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-git-tok-"));
  cpMock.state.routes = [];
  cpMock.state.calls = [];
  for (const name of TOKEN_ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of TOKEN_ENV_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ghAuthToken resolution order", () => {
  it("returns the gh keyring token even when token env vars are set", () => {
    probeRoute({ stdout: "tok-keyring\n", stderr: "", status: 0 });
    process.env.GITHUB_TOKEN = "tok-gh";
    process.env.GH_TOKEN = "tok-gh-tok";
    expect(ghAuthToken(tempDir)).toBe("tok-keyring");
  });

  it("strips the token env vars from the gh probe environment, keeps the rest", () => {
    probeRoute({ stdout: "tok-keyring", stderr: "", status: 0 });
    process.env.GITHUB_TOKEN = "tok-gh";
    process.env.GH_PAT_TOKEN = "tok-pat";
    ghAuthToken(tempDir);
    const env = findProbeEnv();
    expect(env).toBeDefined();
    for (const name of TOKEN_ENV_VARS) {
      expect(env![name]).toBeUndefined();
    }
    expect(env!.PATH).toBeDefined();
  });

  it("falls back to GITHUB_TOKEN when the gh probe fails", () => {
    probeRoute({ stdout: "", stderr: "not logged in", status: 1 });
    process.env.GITHUB_TOKEN = "tok-gh";
    expect(ghAuthToken(tempDir)).toBe("tok-gh");
  });

  it("walks the env chain in order when the probe fails", () => {
    probeRoute({ stdout: "", stderr: "", status: 127 });
    process.env.GITHUB_TOKEN = "tok-1";
    process.env.GITHUB_PAT_TOKEN = "tok-2";
    process.env.GH_PAT_TOKEN = "tok-3";
    process.env.GH_TOKEN = "tok-4";
    expect(ghAuthToken(tempDir)).toBe("tok-1");
    delete process.env.GITHUB_TOKEN;
    expect(ghAuthToken(tempDir)).toBe("tok-2");
    delete process.env.GITHUB_PAT_TOKEN;
    expect(ghAuthToken(tempDir)).toBe("tok-3");
    delete process.env.GH_PAT_TOKEN;
    expect(ghAuthToken(tempDir)).toBe("tok-4");
  });

  it("skips empty and whitespace-only env values", () => {
    probeRoute({ stdout: "", stderr: "", status: 1 });
    process.env.GITHUB_TOKEN = "";
    process.env.GITHUB_PAT_TOKEN = "   ";
    process.env.GH_PAT_TOKEN = "\n\t";
    process.env.GH_TOKEN = "tok-real";
    expect(ghAuthToken(tempDir)).toBe("tok-real");
  });

  it("treats a blank gh probe token (exit 0) as missing", () => {
    probeRoute({ stdout: "  \n", stderr: "", status: 0 });
    process.env.GH_TOKEN = "tok-gh-tok";
    expect(ghAuthToken(tempDir)).toBe("tok-gh-tok");
  });

  it("trims whitespace from env fallback values", () => {
    probeRoute({ stdout: "", stderr: "", status: 1 });
    process.env.GH_TOKEN = "tok-pad\n";
    expect(ghAuthToken(tempDir)).toBe("tok-pad");
  });

  it("throws one actionable error naming the probe and the env chain when all sources fail", () => {
    probeRoute({ stdout: "", stderr: "gh not authenticated", status: 1 });
    let message = "";
    try {
      ghAuthToken(tempDir);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/gh auth token/);
    expect(message).toMatch(/gh not authenticated/);
    expect(message).toMatch(/gh auth login/);
    for (const name of TOKEN_ENV_VARS) {
      expect(message).toContain(name);
    }
  });
});
