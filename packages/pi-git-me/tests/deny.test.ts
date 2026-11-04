// Shell-commit deny tests. The parser is the load-bearing piece: a regex
// cannot tell "git -C dir commit" (deny) from "git log -- commit" (allow)
// because -C consumes the next word, so the match is word-level. The blocker
// wires the parser to the bash tool boundary through the persisted
// git-deny-shell-commit flag (default ON, explicit opt-out).
//
// The 2026-09-16 and 2026-10-01 sessions both contain shell `git commit -F -`
// bypasses of the preview gate, the second after a no-recur promise. That
// recurrence is why this is enforced (opt-out) instead of only guided.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DENY_SHELL_COMMIT_FLAG,
  getAllowHeadlessWriteEnabled,
  getConfirmWriteEnabled,
  getDenyShellCommitEnabled,
  setDenyShellCommitEnabled,
} from "../lib/confirm";
import {
  isGitCommit,
  isShellGitCommit,
  shellCommitBlocker,
  splitSegments,
  stripAndTokenize,
  SHELL_COMMIT_BLOCK_REASON,
} from "../lib/deny";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-git-me-test-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("splitSegments", () => {
  it("splits on pipes, chains, semicolons, newlines", () => {
    expect(splitSegments("git log | cat && git status; git diff\n\n git commit -m x")).toEqual([
      "git log ",
      " cat ",
      " git status",
      " git diff",
      "",
      " git commit -m x",
    ]);
  });

  it("keeps a single command as one segment", () => {
    expect(splitSegments("git commit -m x")).toEqual(["git commit -m x"]);
  });

  it("does not split on separators inside quotes (agy review)", () => {
    expect(splitSegments('echo "a; b" | cat')).toEqual(['echo "a; b" ', " cat"]);
    expect(splitSegments("printf '%s;%s' x")).toEqual(["printf '%s;%s' x"]);
  });

  it("treats backslash-newline as continuation, not a boundary (agy review)", () => {
    expect(splitSegments("git \\\ncommit")).toEqual(["git commit"]);
  });
});

describe("stripAndTokenize", () => {
  it("strips leading env assignments, keeps wrappers for commandWords", () => {
    expect(stripAndTokenize("GIT_EDITOR=true FOO='a b' git commit")).toEqual(["git", "commit"]);
    expect(stripAndTokenize("sudo git commit")).toEqual(["sudo", "git", "commit"]);
    expect(stripAndTokenize("A=1 sudo git commit")).toEqual(["sudo", "git", "commit"]);
  });

  it("respects quotes and escapes", () => {
    expect(stripAndTokenize('git commit -m "a b" \'c d\' e\\ f')).toEqual([
      "git",
      "commit",
      "-m",
      "a b",
      "c d",
      "e f",
    ]);
  });

  it("returns an empty array for an assignment-only segment", () => {
    expect(stripAndTokenize("A=1")).toEqual([]);
  });
});

describe("isGitCommit", () => {
  const commitCases: string[][] = [
    ["git", "commit"],
    ["git", "commit", "-m", "x"],
    ["git", "commit", "--amend"],
    ["git", "-C", "repo", "commit"],
    ["git", "-c", "core.editor=true", "commit"],
    ["git", "--git-dir=x", "commit"],
    ["git", "-Crepo", "commit"],
  ];
  it.each(commitCases.map((c) => [c]))(`matches %o`, (words) => {
    expect(isGitCommit(words)).toBe(true);
  });

  const rejectCases: string[][] = [
    ["git", "log"],
    ["git", "status"],
    ["git", "commit-tree", "x"],
    ["git", "branch", "commit"],
    ["git", "log", "--", "commit"],
    ["git", "push"],
    ["hub", "commit"],
    ["git"],
    ["gitlog"],
  ];
  it.each(rejectCases.map((c) => [c]))(`rejects %o`, (words) => {
    expect(isGitCommit(words)).toBe(false);
  });
});

describe("isShellGitCommit", () => {
  it.each([
    "git commit -m wip",
    "GIT_EDITOR=true git commit",
    "sudo git commit",
    "command git commit",
    "git log | cat && git commit -m x",
    "git status; git commit --amend",
    "git -C sub/repo commit",
    'git commit -m "multi word"',
    "A=1 sudo git -c core.editor=true commit",
    // backslash-newline continuation must not split the command (agy review)
    "git \\\ncommit -m wip",
    "git \\\n  commit",
    // subshells and groups
    "(git commit -m bypass)",
    "{ git commit; }",
    "(cd x && git commit)",
    // env / absolute-path / wrapper-flag forms (agy review)
    "env git commit",
    "env FOO=1 git commit",
    "/usr/bin/git commit",
    "sudo -E git commit",
    "sudo -u root git commit",
    "git --exec-path /x commit",
    // round 2 (agy re-review)
    "sleep 1 & git commit",
    "VAR=foo\\ bar git commit",
    "GIT_AUTHOR_NAME=John\\ Doe git commit -m x",
    "command -p git commit",
    "sudo --user root git commit",
    "env --chdir /x git commit",
    "echo 'a\\'; git commit",
    "git \\\r\ncommit",
    'echo "\\\\"; git commit',
    'cd "C:\\\\"; git commit',
  ])("denies %s", (command) => {
    expect(isShellGitCommit(command)).toBe(true);
  });

  it.each([
    "git log",
    "git status",
    "git push",
    "git commit-tree x",
    "git branch commit",
    "git log -- commit",
    "echo git commit",
    "gh pr create",
    "ls",
    "",
    // separators inside quotes are not command boundaries (agy review)
    'echo "a; git commit"',
    'echo "x && git commit"',
    "printf '%s' 'git commit'",
    'git log --format="%H;%s"',
    "git commit-tree $(git rev-parse HEAD)",
    // round 2 (agy re-review): backslash does not escape the quote inside single quotes here
    'echo \'a\\\'; git status',
    'echo "a\\" b"; git status',
    'echo \'it\'\'s\'; git status',
  ])("allows %s", (command) => {
    expect(isShellGitCommit(command)).toBe(false);
  });
});

describe("shellCommitBlocker", () => {
  const bashEvent = (command: string) => ({
    toolName: "bash",
    toolCallId: "call-1",
    input: { command },
  });

  it("blocks git commit through the bash tool when the flag is on (default)", async () => {
    const blocker = shellCommitBlocker();
    const result = (await blocker(bashEvent("git commit -m wip"))) as {
      block: boolean;
      reason: string;
    };
    expect(result.block).toBe(true);
    expect(result.reason).toContain(SHELL_COMMIT_BLOCK_REASON);
    expect(result.reason).toMatch(/git_commit/);
  });

  it("passes non-commit commands", async () => {
    const blocker = shellCommitBlocker();
    expect(await blocker(bashEvent("git status"))).toBeUndefined();
  });

  it("ignores tools other than bash", async () => {
    const blocker = shellCommitBlocker();
    const event = { toolName: "read", toolCallId: "c", input: { path: "x" } };
    expect(await blocker(event)).toBeUndefined();
  });

  it("does not throw when the event has no input (agy review)", async () => {
    const blocker = shellCommitBlocker();
    expect(await blocker({ toolName: "bash" })).toBeUndefined();
    expect(await blocker({ toolName: "bash", input: undefined })).toBeUndefined();
  });

  it("passes everything when the flag is off", async () => {
    setDenyShellCommitEnabled(false);
    const blocker = shellCommitBlocker();
    expect(await blocker(bashEvent("git commit -m x"))).toBeUndefined();
  });

  it("reads the flag live (toggle applies without reload)", async () => {
    const blocker = shellCommitBlocker();
    expect(await blocker(bashEvent("git commit"))).toBeDefined();
    setDenyShellCommitEnabled(false);
    expect(await blocker(bashEvent("git commit"))).toBeUndefined();
    setDenyShellCommitEnabled(true);
    expect(await blocker(bashEvent("git commit"))).toBeDefined();
  });
});

describe("denyShellCommit flag persistence", () => {
  it("defaults to ON (enforced), opt-out via explicit false", () => {
    expect(getDenyShellCommitEnabled()).toBe(true);
  });

  it("flag name matches the documented public API", () => {
    expect(DENY_SHELL_COMMIT_FLAG).toBe("git-deny-shell-commit");
  });

  it("round-trips through the settings file", () => {
    expect(setDenyShellCommitEnabled(false)).toBe(true);
    expect(getDenyShellCommitEnabled()).toBe(false);
    expect(setDenyShellCommitEnabled(true)).toBe(true);
    expect(getDenyShellCommitEnabled()).toBe(true);
  });

  it("does not clobber the other flags on write", () => {
    // All three flags share one settings file; a read-merge-write must keep
    // the siblings intact (regression: early writeSettings overwrote).
    setDenyShellCommitEnabled(false);
    expect(getDenyShellCommitEnabled()).toBe(false);
    expect(getConfirmWriteEnabled()).toBe(true);
    expect(getAllowHeadlessWriteEnabled()).toBe(false);
  });
});
