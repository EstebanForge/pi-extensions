// git_commit success-path tests: the apply step is the ONLY place the
// extension uses the async `spawn` (message piped to stdin via `git commit
// -F -`), so tools.test.ts (sync-only mock, spawn stubbed to throw) cannot
// cover it. This file adds a fake child for spawn so the full success path
// runs, and pins the result's web-url line: the new commit's URL, derived
// from the configured remote and shown when a parseable remote exists.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- child_process mock ------------------------------------------------------
// spawnSync routes exactly like tools.test.ts; spawn returns a minimal fake
// child whose stdin.end() settles `close` with exit 0 (async, so execute's
// await chain resolves deterministically).
const { cpMock } = vi.hoisted(() => {
  type FakeResult = { stdout: string; stderr: string; status: number };
  type Route = { match: (cmd: string, args: string[]) => boolean; result: () => FakeResult };
  const state: { routes: Route[]; commits: string[][] } = { routes: [], commits: [] };
  const spawnSyncMock = (cmd: string, args: string[]): FakeResult => {
    for (const route of state.routes) {
      if (route.match(cmd, args)) return route.result();
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  const spawnMock = (_cmd: string, args: string[]) => {
    state.commits.push([...args]);
    const child = {
      _close: undefined as ((code: number | null) => void) | undefined,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on(ev: string, cb: (code: number | null) => void) {
        if (ev === "close") child._close = cb;
      },
      kill: () => {},
      stdin: {
        on: () => {},
        end: () => {
          setImmediate(() => child._close?.(0));
        },
      },
    };
    return child;
  };
  return { cpMock: { state, spawnSyncMock, spawnMock } };
});

vi.mock("node:child_process", () => ({
  spawnSync: cpMock.spawnSyncMock,
  spawn: cpMock.spawnMock,
}));

import { _resetAuthCache } from "../lib/auth";
import { commitTool } from "../lib/tools/commit";
import { invokeWithCtx, makeCtx, makeStubUI, firstText } from "./_helpers";

const SHA = "abc1234def5678";

// A staged change exists (diff --cached --quiet exits 1) and HEAD resolves
// to SHA. With `remote` set, `git remote get-url origin` answers with it;
// tests that need no-remote / fallback behavior omit it and add their own
// remote routes.
type Route = { match: (c: string, a: string[]) => boolean; result: () => { stdout: string; stderr: string; status: number } };

function baseRoutes(remote?: string): Route[] {
  const routes: Route[] = [
    { match: (c, a) => c === "git" && a[0] === "rev-parse" && a.includes("--is-inside-work-tree"), result: () => ({ stdout: "true", stderr: "", status: 0 }) },
    { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("--cached") && a.includes("--quiet"), result: () => ({ stdout: "", stderr: "", status: 1 }) },
    { match: (c, a) => c === "git" && a[0] === "rev-parse" && a[1] === "HEAD", result: () => ({ stdout: `${SHA}\n`, stderr: "", status: 0 }) },
  ];
  if (remote !== undefined) {
    routes.push({
      match: (c, a) => c === "git" && a[0] === "remote" && a[1] === "get-url",
      result: () => ({ stdout: `${remote}\n`, stderr: "", status: 0 }),
    });
  }
  return routes;
}

function setupRoutes(routes: Route[]): void {
  cpMock.state.routes = routes;
  cpMock.state.commits = [];
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-git-me-commit-url-test-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  _resetAuthCache();
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  _resetAuthCache();
});

describe("git_commit - success result web url", () => {
  it("appends the commit URL derived from an scp-like GitHub remote", async () => {
    setupRoutes(baseRoutes("git@github.com:octo/repo.git"));
    const ui = makeStubUI({ editorResponse: "feat: x" });
    const result = await invokeWithCtx(commitTool, { subject: "feat: x" }, makeCtx(ui));
    expect(firstText(result)).toContain("Committed staged changes with message.");
    expect(firstText(result)).toContain(`  url: https://github.com/octo/repo/commit/${SHA}`);
  });

  it("maps bitbucket.org to /commits/<sha> and keeps custom http ports", async () => {
    setupRoutes(baseRoutes("git@bitbucket.org:ws/repo.git"));
    const r1 = await invokeWithCtx(commitTool, { subject: "feat: b" }, makeCtx(makeStubUI({ editorResponse: "feat: b" })));
    expect(firstText(r1)).toContain(`https://bitbucket.org/ws/repo/commits/${SHA}`);

    setupRoutes(baseRoutes("http://gitea.local:3000/octo/repo.git"));
    const r2 = await invokeWithCtx(commitTool, { subject: "feat: g" }, makeCtx(makeStubUI({ editorResponse: "feat: g" })));
    expect(firstText(r2)).toContain(`http://gitea.local:3000/octo/repo/commit/${SHA}`);
  });

  it("falls back to the first listed remote when origin is absent", async () => {
    setupRoutes([
      ...baseRoutes(),
      { match: (c, a) => c === "git" && a[0] === "remote" && a[1] === "get-url" && a[2] === "origin", result: () => ({ stdout: "", stderr: "error: No such remote 'origin'", status: 128 }) },
      { match: (c, a) => c === "git" && a[0] === "remote" && a.length === 1, result: () => ({ stdout: "upstream\n", stderr: "", status: 0 }) },
      { match: (c, a) => c === "git" && a[0] === "remote" && a[1] === "get-url" && a[2] === "upstream", result: () => ({ stdout: "ssh://git@codeberg.org/octo/repo.git\n", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "feat: f" });
    const result = await invokeWithCtx(commitTool, { subject: "feat: f" }, makeCtx(ui));
    expect(firstText(result)).toContain(`https://codeberg.org/octo/repo/commit/${SHA}`);
  });

  it("omits the url line when the repo has no remote", async () => {
    setupRoutes([
      ...baseRoutes(),
      { match: (c, a) => c === "git" && a[0] === "remote" && a[1] === "get-url" && a[2] === "origin", result: () => ({ stdout: "", stderr: "error: No such remote 'origin'", status: 128 }) },
      // Listing only: a.length===1 so get-url calls keep their own routes.
      { match: (c, a) => c === "git" && a[0] === "remote" && a.length === 1, result: () => ({ stdout: "", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "feat: local" });
    const result = await invokeWithCtx(commitTool, { subject: "feat: local" }, makeCtx(ui));
    expect(firstText(result)).toContain("Committed staged changes with message.");
    expect(firstText(result)).not.toContain("url:");
  });

  it("omits the url line when the remote cannot map to a web URL", async () => {
    // Local filesystem remote: a valid remote, no web home.
    setupRoutes(baseRoutes("/srv/git/repo"));
    const ui = makeStubUI({ editorResponse: "feat: x" });
    const result = await invokeWithCtx(commitTool, { subject: "feat: x" }, makeCtx(ui));
    expect(firstText(result)).toContain("Committed staged changes with message.");
    expect(firstText(result)).not.toContain("url:");
  });
});

// Staged-state race guard (incident lore: a human reset the staging area
// while a commit dialog was open). The tool snapshots the state as sha-256
// over `git rev-parse HEAD` + `git write-tree` before the gate and
// re-snapshots after acceptance; any change aborts with nothing committed.
// Hashing HEAD too catches the amend attack a diff-only hash misses: a side
// commit by the human while the index is empty leaves the index unchanged
// but moves HEAD, so `--amend` would otherwise rewrite the human's commit.
describe("git_commit - staged-state race guard (shared checkout)", () => {
  const HEAD_1 = "abc1234567890";
  const HEAD_2 = "deadbeef1234567";
  const TREE_EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const TREE_A = "treeaaaa";
  const TREE_B = "treebbbb";

  function headRoute(payloads: string[], status = 0): Route {
    let calls = 0;
    return {
      match: (c, a) => c === "git" && a[0] === "rev-parse" && a[1] === "HEAD",
      result: () => ({ stdout: payloads[Math.min(calls++, payloads.length - 1)], stderr: status === 0 ? "" : "fatal: bad", status }),
    };
  }

  function writeTreeRoute(payloads: string[], status = 0): Route {
    let calls = 0;
    return {
      match: (c, a) => c === "git" && a[0] === "write-tree",
      result: () => ({ stdout: payloads[Math.min(calls++, payloads.length - 1)], stderr: status === 0 ? "" : "fatal: conflict", status }),
    };
  }

  it("stable HEAD + index between gate and apply -> commits normally", async () => {
    setupRoutes([headRoute([HEAD_1]), writeTreeRoute([TREE_A]), ...baseRoutes("git@github.com:octo/repo.git")]);
    const ui = makeStubUI({ editorResponse: "feat: x" });
    const result = await invokeWithCtx(commitTool, { subject: "feat: x" }, makeCtx(ui));
    expect(firstText(result)).toContain("Committed staged changes with message.");
    expect(cpMock.state.commits).toHaveLength(1);
  });

  it("index changed while the dialog was open -> aborts, nothing committed", async () => {
    setupRoutes([headRoute([HEAD_1]), writeTreeRoute([TREE_A, TREE_B]), ...baseRoutes()]);
    const ui = makeStubUI({ editorResponse: "feat: x" });
    const result = await invokeWithCtx(commitTool, { subject: "feat: x" }, makeCtx(ui));
    expect(firstText(result)).toContain("staged changes changed");
    expect(firstText(result)).toContain("Nothing was committed");
    expect(cpMock.state.commits).toHaveLength(0);
  });

  it("HEAD moved with an EMPTY index (amend attack) -> aborts, nothing committed", async () => {
    // Peer review (claude 2026-11-11): a diff-only hash is blind to a human
    // side commit while the index is empty — the agent's --amend would then
    // rewrite the human's new commit. The HEAD SHA in the snapshot closes it.
    setupRoutes([headRoute([HEAD_1, HEAD_2]), writeTreeRoute([TREE_EMPTY, TREE_EMPTY]), ...baseRoutes()]);
    const ui = makeStubUI({ editorResponse: "fix: tweaked" });
    const result = await invokeWithCtx(commitTool, { subject: "fix: tweaked", amend: true }, makeCtx(ui));
    expect(firstText(result)).toContain("staged changes changed");
    expect(cpMock.state.commits).toHaveLength(0);
  });

  it("staged-state snapshot failure -> refuses closed, nothing committed", async () => {
    // write-tree exits 1 on a conflicted index — a real snapshot failure
    // (rev-parse HEAD 128 is the unborn-branch case, not a failure).
    setupRoutes([headRoute([HEAD_1]), writeTreeRoute([TREE_A], 1), ...baseRoutes()]);
    const ui = makeStubUI({ editorResponse: "feat: x" });
    const result = await invokeWithCtx(commitTool, { subject: "feat: x" }, makeCtx(ui));
    expect(firstText(result)).toContain("could not be hashed");
    expect(cpMock.state.commits).toHaveLength(0);
  });

  it("amend path is guarded too: staging appearing mid-dialog aborts", async () => {
    setupRoutes([headRoute([HEAD_1]), writeTreeRoute([TREE_EMPTY, TREE_A]), ...baseRoutes()]);
    const ui = makeStubUI({ editorResponse: "fix: tweaked" });
    const result = await invokeWithCtx(commitTool, { subject: "fix: tweaked", amend: true }, makeCtx(ui));
    expect(firstText(result)).toContain("staged changes changed");
    expect(cpMock.state.commits).toHaveLength(0);
  });
});
