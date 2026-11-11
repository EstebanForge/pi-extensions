// Unit tests for lib/pr-target.ts: the wrong-target hardening primitives.
//
// `node:child_process` is mocked (same router shape as tools.test.ts) so no
// test shells out to real git / gh. These tests pin the resolver contract the
// write tools depend on after the 2026-11-11 incident: branch-bound PR
// resolution only ever binds an OPEN PR whose headRefName equals the
// checked-out branch, and apply-time verification aborts on identity drift.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { cpMock } = vi.hoisted(() => {
  type FakeResult = { stdout: string; stderr: string; status: number };
  type Route = {
    match: (cmd: string, args: string[]) => boolean;
    result: () => FakeResult;
  };
  const state: { routes: Route[] } = { routes: [] };
  const spawnSyncMock = (
    cmd: string,
    args: string[],
  ): FakeResult => {
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

import { _resetAuthCache } from "../lib/auth";
import {
  resolvePrForBranch,
  ghPrByNumber,
  verifyPrTarget,
  prTargetLabel,
  branchPrRefusal,
  type BranchPrResolution,
} from "../lib/pr-target";
import { ghPrViewCurrentBranch } from "../lib/git";
import type { GhPullRequest } from "../lib/types";

type Route = { match: (c: string, a: string[]) => boolean; result: () => { stdout: string; stderr: string; status: number } };

const BRANCH = "feat";
const BRANCH_ROUTE: Route = {
  match: (c, a) => c === "git" && a[0] === "symbolic-ref",
  result: () => ({ stdout: `${BRANCH}\n`, stderr: "", status: 0 }),
};
const IN_REPO_ROUTE: Route = {
  match: (c, a) => c === "git" && a.includes("--is-inside-work-tree"),
  result: () => ({ stdout: "true\n", stderr: "", status: 0 }),
};
const DETACHED_ROUTES: Route[] = [
  { match: (c, a) => c === "git" && a[0] === "symbolic-ref", result: () => ({ stdout: "", stderr: "fatal: ref refs/heads/x not a symbolic ref", status: 128 }) },
  { match: (c, a) => c === "git" && a[0] === "rev-parse" && !a.includes("--is-inside-work-tree"), result: () => ({ stdout: "abc1234\n", stderr: "", status: 0 }) },
];
const REPO_VIEW_ROUTE: Route = {
  match: (c, a) => c === "gh" && a[0] === "repo" && a[1] === "view",
  result: () => ({ stdout: JSON.stringify({ id: "R1", nameWithOwner: "octo/repo" }), stderr: "", status: 0 }),
};

function prRow(overrides: Partial<GhPullRequest> = {}): GhPullRequest {
  return {
    number: 7,
    title: "t",
    body: "",
    state: "OPEN",
    url: `https://github.com/octo/repo/pull/${overrides.number ?? 7}`,
    baseRefName: "main",
    headRefName: BRANCH,
    isDraft: false,
    ...overrides,
  };
}

function listRoute(rows: unknown, status = 0): Route {
  return {
    match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "list",
    result: () => ({ stdout: JSON.stringify(rows), stderr: status === 0 ? "" : "boom", status }),
  };
}

// Route that records the matched argv (for asserting the exact gh invocation).
function recordingRoute(
  matcher: (c: string, a: string[]) => boolean,
  seen: string[][],
  respond: () => { stdout: string; stderr: string; status: number },
): Route {
  return {
    match: (c, a) => {
      if (!matcher(c, a)) return false;
      seen.push([...a]);
      return true;
    },
    result: respond,
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-git-me-pr-target-test-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  _resetAuthCache();
  cpMock.state.routes = [BRANCH_ROUTE, IN_REPO_ROUTE];
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  _resetAuthCache();
});

// The resolver addresses the branch explicitly: argv pins --head, and the
// state filter is code-side (--state all so closed rows stay visible for the
// refusal messages).
describe("resolvePrForBranch", () => {
  it("one OPEN PR with matching head -> ok", () => {
    cpMock.state.routes = [listRoute([prRow()]), BRANCH_ROUTE, IN_REPO_ROUTE];
    const res = resolvePrForBranch("/repo");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.pr.number).toBe(7);
      expect(res.branch).toBe(BRANCH);
    }
  });

  it("records `gh pr list --head <branch> --state all --json ...` argv (no bare pr view)", () => {
    const calls: string[][] = [];
    cpMock.state.routes = [
      recordingRoute(
        (c, a) => c === "gh" && a[0] === "pr" && a[1] === "list",
        calls,
        () => ({ stdout: "[]", stderr: "", status: 0 }),
      ),
      BRANCH_ROUTE,
      IN_REPO_ROUTE,
    ];
    resolvePrForBranch("/repo");
    expect(calls).toHaveLength(1);
    const argv = calls[0];
    expect(argv.slice(0, 2)).toEqual(["pr", "list"]);
    expect(argv).toContain("--head");
    expect(argv[argv.indexOf("--head") + 1]).toBe(BRANCH);
    expect(argv).toContain("--state");
    expect(argv[argv.indexOf("--state") + 1]).toBe("all");
    expect(argv).toContain("--limit");
    expect(argv[argv.indexOf("--limit") + 1]).toBe("50");
  });

  it("empty rows -> none", () => {
    cpMock.state.routes = [listRoute([]), BRANCH_ROUTE, IN_REPO_ROUTE];
    const res = resolvePrForBranch("/repo");
    expect(res.kind).toBe("none");
    if (res.kind === "none") expect(res.branch).toBe(BRANCH);
  });

  it("CLOSED row with matching head -> closed (never bound as ok)", () => {
    cpMock.state.routes = [listRoute([prRow({ state: "CLOSED" })]), BRANCH_ROUTE, IN_REPO_ROUTE];
    const res = resolvePrForBranch("/repo");
    expect(res.kind).toBe("closed");
    if (res.kind === "closed") {
      expect(res.pr.number).toBe(7);
      expect(res.branch).toBe(BRANCH);
    }
  });

  it("MERGED row with matching head -> closed kind too (merged is not writable either)", () => {
    cpMock.state.routes = [listRoute([prRow({ state: "MERGED" })]), BRANCH_ROUTE, IN_REPO_ROUTE];
    expect(resolvePrForBranch("/repo").kind).toBe("closed");
  });

  it("closed row + open row -> ok (the open PR wins)", () => {
    cpMock.state.routes = [listRoute([prRow({ state: "CLOSED", number: 3 }), prRow({ number: 7 })]), BRANCH_ROUTE, IN_REPO_ROUTE];
    const res = resolvePrForBranch("/repo");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.pr.number).toBe(7);
  });

  it("two OPEN rows from one head -> ambiguous carrying both numbers", () => {
    cpMock.state.routes = [listRoute([prRow({ number: 7 }), prRow({ number: 9, baseRefName: "other" })]), BRANCH_ROUTE, IN_REPO_ROUTE];
    const res = resolvePrForBranch("/repo");
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") {
      expect(res.prs.map((p) => p.number)).toEqual([7, 9]);
    }
  });

  it("row whose headRefName is not the checked-out branch -> mismatch (gh matched something opaque)", () => {
    cpMock.state.routes = [listRoute([prRow({ headRefName: "feature/users-multi-tier" })]), BRANCH_ROUTE, IN_REPO_ROUTE];
    const res = resolvePrForBranch("/repo");
    expect(res.kind).toBe("mismatch");
    if (res.kind === "mismatch") {
      expect(res.pr.number).toBe(7);
      expect(res.pr.headRefName).toBe("feature/users-multi-tier");
      expect(res.branch).toBe(BRANCH);
    }
  });

  it("detached HEAD -> none with no branch name", () => {
    cpMock.state.routes = [IN_REPO_ROUTE, ...DETACHED_ROUTES, listRoute([prRow()])];
    const res = resolvePrForBranch("/repo");
    expect(res.kind).toBe("none");
    if (res.kind === "none") expect(res.branch).toBeNull();
  });

  it("skips cross-fork rows with the same head branch name (peer review BLOCKER: stranger fork false bind)", () => {
    const fork = prRow({ number: 85, isCrossRepository: true, headRepositoryOwner: { login: "stranger" } });
    const own = prRow({ number: 107 });
    cpMock.state.routes = [BRANCH_ROUTE, IN_REPO_ROUTE, REPO_VIEW_ROUTE, listRoute([fork, own])];
    const res = resolvePrForBranch("/repo");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.pr.number).toBe(107);
  });

  it("cross-fork row binds only when its head owner matches the local repo", () => {
    const fork = prRow({ number: 85, isCrossRepository: true, headRepositoryOwner: { login: "octo" } });
    cpMock.state.routes = [BRANCH_ROUTE, IN_REPO_ROUTE, REPO_VIEW_ROUTE, listRoute([fork])];
    expect(resolvePrForBranch("/repo").kind).toBe("ok");
  });

  it("cross-fork rows are skipped when the local repo owner cannot be resolved", () => {
    const fork = prRow({ number: 85, isCrossRepository: true, headRepositoryOwner: { login: "octo" } });
    cpMock.state.routes = [BRANCH_ROUTE, IN_REPO_ROUTE, listRoute([fork])];
    const res = resolvePrForBranch("/repo");
    expect(res.kind).toBe("none");
    if (res.kind === "none") expect(res.branch).toBe(BRANCH);
  });

  it("same-repo rows need no repo lookup: ok with no repo view route wired", () => {
    cpMock.state.routes = [BRANCH_ROUTE, IN_REPO_ROUTE, listRoute([prRow()])];
    expect(resolvePrForBranch("/repo").kind).toBe("ok");
  });

  it("gh pr list failure -> error kind carrying the failure detail (peer review: failure is not 'no PR')", () => {
    cpMock.state.routes = [listRoute([], 1), BRANCH_ROUTE, IN_REPO_ROUTE];
    const res = resolvePrForBranch("/repo");
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.detail).toContain("1");
      expect(res.branch).toBe(BRANCH);
    }
  });

  it("malformed JSON -> error kind too", () => {
    cpMock.state.routes = [
      BRANCH_ROUTE,
      IN_REPO_ROUTE,
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "list", result: () => ({ stdout: "<html>err</html>", stderr: "", status: 0 }) },
    ];
    expect(resolvePrForBranch("/repo").kind).toBe("error");
  });
});

// Shared refusal text for the non-ok kinds the write tools must refuse on.
describe("branchPrRefusal", () => {
  it("null for ok and none (tools handle those themselves)", () => {
    expect(branchPrRefusal({ kind: "ok", pr: prRow(), branch: BRANCH })).toBeNull();
    expect(branchPrRefusal({ kind: "none", branch: BRANCH })).toBeNull();
  });

  it("closed: names the PR, its state and head -> base, and tells the agent to pass pr explicitly", () => {
    const msg = branchPrRefusal({ kind: "closed", pr: prRow({ state: "CLOSED" }), branch: BRANCH })!;
    expect(msg).toContain("#7");
    expect(msg).toContain("CLOSED");
    expect(msg).toContain(`${BRANCH} -> main`);
    expect(msg).toContain("pr` explicitly");
  });

  it("mismatch: names the current branch and the resolved PR's head/base", () => {
    const msg = branchPrRefusal({ kind: "mismatch", pr: prRow({ headRefName: "other" }), branch: BRANCH })!;
    expect(msg).toContain(BRANCH);
    expect(msg).toContain("#7");
    expect(msg).toContain("other -> main");
  });

  it("ambiguous: lists every open PR number and its base", () => {
    const msg = branchPrRefusal({ kind: "ambiguous", prs: [prRow({ number: 7 }), prRow({ number: 9, baseRefName: "other" })], branch: BRANCH })!;
    expect(msg).toContain("#7");
    expect(msg).toContain("#9");
    expect(msg).toContain("other");
  });

  it("error: names the failure and refuses rather than guessing", () => {
    const msg = branchPrRefusal({ kind: "error", branch: BRANCH, detail: "gh pr list exited 1" })!;
    expect(msg).toContain("resolution failed");
    expect(msg).toContain("gh pr list exited 1");
    expect(msg).toContain("pr` explicitly");
  });
});

describe("ghPrByNumber", () => {
  it("fetches by explicit number, full field set", () => {
    const seen: string[][] = [];
    cpMock.state.routes = [
      recordingRoute(
        (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view",
        seen,
        () => ({ stdout: JSON.stringify(prRow()), stderr: "", status: 0 }),
      ),
    ];
    const pr = ghPrByNumber(7, "/repo");
    expect(pr?.number).toBe(7);
    expect(seen[0].join(" ")).toContain("pr view 7");
    expect(seen[0]).toContain("--json");
    expect(seen[0].join(" ")).toContain("headRefName");
  });

  it("repo slug is passed as -R (cross-repo snapshot)", () => {
    const seen: string[][] = [];
    cpMock.state.routes = [
      recordingRoute(
        (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view",
        seen,
        () => ({ stdout: JSON.stringify(prRow()), stderr: "", status: 0 }),
      ),
    ];
    ghPrByNumber(7, "/repo", "foo/bar");
    expect(seen[0].join(" ")).toContain("-R foo/bar");
  });

  it("gh failure or malformed JSON -> null", () => {
    cpMock.state.routes = [
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view", result: () => ({ stdout: "", stderr: "Could not resolve to a PullRequest", status: 1 }) },
    ];
    expect(ghPrByNumber(4212, "/repo")).toBeNull();
    cpMock.state.routes = [
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view", result: () => ({ stdout: "not json", stderr: "", status: 0 }) },
    ];
    expect(ghPrByNumber(7, "/repo")).toBeNull();
  });
});

describe("verifyPrTarget", () => {
  const expected = prRow();

  function viewRoute(row: unknown | null): Route {
    return {
      match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view",
      result: () =>
        row === null
          ? { stdout: "", stderr: "Could not resolve to a PullRequest", status: 1 }
          : { stdout: JSON.stringify(row), stderr: "", status: 0 },
    };
  }

  it("identical identity -> ok", () => {
    cpMock.state.routes = [viewRoute(expected)];
    expect(verifyPrTarget(expected, "/repo")).toEqual({ ok: true });
  });

  it("state drift -> named old -> new state, nothing sent", () => {
    cpMock.state.routes = [viewRoute({ ...expected, state: "MERGED" })];
    const res = verifyPrTarget(expected, "/repo");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("state changed OPEN -> MERGED");
      expect(res.message).toContain("#7");
    }
  });

  it("head drift and base drift are named", () => {
    cpMock.state.routes = [viewRoute({ ...expected, headRefName: "rebased" })];
    const res = verifyPrTarget(expected, "/repo");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("head changed feat -> rebased");

    cpMock.state.routes = [viewRoute({ ...expected, baseRefName: "develop" })];
    const res2 = verifyPrTarget(expected, "/repo");
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.message).toContain("base changed main -> develop");
  });

  it("repo drift (url moved to another owner/name) is refused", () => {
    cpMock.state.routes = [viewRoute({ ...expected, url: "https://github.com/someone-else/repo/pull/7" })];
    const res = verifyPrTarget(expected, "/repo");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("repo changed");
  });

  it("PR vanished (re-fetch fails) -> refused", () => {
    cpMock.state.routes = [viewRoute(null)];
    const res = verifyPrTarget(expected, "/repo");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("could not be re-fetched");
  });

  it("repo slug is threaded to the re-fetch (cross-repo verify)", () => {
    const seen: string[][] = [];
    cpMock.state.routes = [
      recordingRoute(
        (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view",
        seen,
        () => ({ stdout: JSON.stringify(prRow()), stderr: "", status: 0 }),
      ),
    ];
    expect(verifyPrTarget(expected, "/repo", "foo/bar").ok).toBe(true);
    expect(seen[0].join(" ")).toContain("-R foo/bar");
  });
});

describe("prTargetLabel", () => {
  it("states number, state, and head -> base", () => {
    expect(prTargetLabel(prRow())).toBe(`PR #7 (OPEN, ${BRANCH} -> main)`);
  });

  it("appends the checked-out branch when known", () => {
    expect(prTargetLabel(prRow(), BRANCH)).toBe(`PR #7 (OPEN, ${BRANCH} -> main, branch "${BRANCH}")`);
  });
});

// The read tool keeps the raw bare view (any state, gh-resolved); write tools
// must NOT import it. Pin the split so a future write-tool caller cannot
// quietly regress to the opaque resolver.
describe("ghPrViewCurrentBranch (read-only, pr-info only)", () => {
  it("still returns whatever gh answers, closed PRs included", () => {
    cpMock.state.routes = [
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view", result: () => ({ stdout: JSON.stringify(prRow({ state: "CLOSED" })), stderr: "", status: 0 }) },
      BRANCH_ROUTE,
      IN_REPO_ROUTE,
    ];
    const pr = ghPrViewCurrentBranch("/repo");
    expect(pr?.state).toBe("CLOSED");
  });
});

// Type-level exhaustiveness guard: adding a kind without a refusal text is a
// compile error, and the runtime mapping below must stay total.
describe("branchPrRefusal covers every non-ok kind", () => {
  it("handles all resolver kinds without throwing", () => {
    const kinds: BranchPrResolution[] = [
      { kind: "ok", pr: prRow(), branch: BRANCH },
      { kind: "none", branch: BRANCH },
      { kind: "closed", pr: prRow(), branch: BRANCH },
      { kind: "ambiguous", prs: [prRow()], branch: BRANCH },
      { kind: "mismatch", pr: prRow(), branch: BRANCH },
      { kind: "error", branch: BRANCH, detail: "x" },
    ];
    for (const res of kinds) {
      expect(() => branchPrRefusal(res)).not.toThrow();
    }
  });
});
