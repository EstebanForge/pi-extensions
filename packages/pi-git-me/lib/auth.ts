// Environment detection for git-me tools.
//
// Unlike pi-slack-me (which authenticates with a single env var), git-me
// relies on two external CLIs the user is expected to have installed and
// authenticated: `git` and the `gh` GitHub CLI. Both are ubiquitous on dev
// machines, but the extension surfaces a clear error when either is missing
// or when the working directory is not inside a git repo.
//
// We never ask the user to paste tokens. `gh` already manages its own OAuth
// flow; the extension simply shells out to it.

import { spawnSync } from "node:child_process";

// `git rev-parse --is-inside-work-tree` exits 0 with "true" when the cwd is
// inside a git repository. We cache the result per cwd for REPO_CACHE_MS so a
// tool that calls isGitRepo() multiple times in one turn does not re-spawn
// the process, but a `git init` mid-session takes effect after the TTL.
const REPO_CACHE_MS = 60_000;
interface RepoCacheEntry { value: boolean; at: number }
const repoCache = new Map<string, RepoCacheEntry>();

export class GitMeEnvError extends Error {
  readonly kind: "no_git" | "no_gh" | "no_repo" | "gh_not_authed";
  constructor(kind: GitMeEnvError["kind"], message: string) {
    super(message);
    this.name = "GitMeEnvError";
    this.kind = kind;
  }
}

/**
 * Returns true when the cwd (default: process.cwd()) is inside a git
 * working tree. Cached per cwd. Does not throw.
 */
export function isGitRepo(cwd: string = process.cwd()): boolean {
  const cached = repoCache.get(cwd);
  const now = Date.now();
  if (cached && now - cached.at < REPO_CACHE_MS) return cached.value;
  const result = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  const ok = result.exitCode === 0 && result.stdout.trim() === "true";
  repoCache.set(cwd, { value: ok, at: now });
  return ok;
}

// -------------------------------------------------- gh auth helpers -------
// hasGh / isGhAuthed / requireGh take NO cwd on purpose. `gh` stores its
// auth state host-globally (in ~/.config/gh), not per-repo, so `gh auth status`
// is the same answer in every working directory. Threading cwd here would
// imply repo-scoped auth that does not exist. (Per-host enterprise setups are
// handled by gh's own config, still cwd-independent.) Only the git/gh COMMAND
// execution helpers below (runGit / runGh) and the repo detection (isGitRepo)
// are cwd-sensitive.

/**
 * Returns true when `gh --version` exits 0. Cached. Does not throw.
 */
export function hasGh(): boolean {
  return runGh(["--version"]).exitCode === 0;
}

/**
 * Returns true when `gh auth status` reports an authenticated user. Cached
 * for 60s (matches pi-slack-me auth cache window). Does not throw.
 */
let ghAuthedCache: { value: boolean; at: number } | undefined;
const GH_AUTH_CACHE_MS = 60_000;

export function isGhAuthed(): boolean {
  const now = Date.now();
  if (ghAuthedCache && now - ghAuthedCache.at < GH_AUTH_CACHE_MS) {
    return ghAuthedCache.value;
  }
  const result = runGh(["auth", "status"]);
  const ok = result.exitCode === 0;
  ghAuthedCache = { value: ok, at: now };
  return ok;
}

/**
 * Throws a GitMeEnvError if the cwd is not inside a git repo. Use inside a
 * tool's execute() so the agent gets a single actionable message.
 */
export function requireGitRepo(cwd: string = process.cwd()): void {
  if (!isGitRepo(cwd)) {
    throw new GitMeEnvError(
      "no_repo",
      `git-me: cwd "${cwd}" is not inside a git working tree. Run this tool from inside a repository.`,
    );
  }
}

/**
 * Throws a GitMeEnvError when `gh` is missing or not authenticated. Call in
 * every gh-backed tool before any `gh` invocation, so the agent gets one
 * actionable message instead of a collapsed "no PR found" error (which used
 * to conflate no-PR, gh-missing, and gh-unauthed, and made the agent try to
 * OPEN a PR on a machine without `gh`).
 */
export function requireGh(): void {
  if (!hasGh()) {
    throw new GitMeEnvError(
      "no_gh",
      "git-me: the `gh` CLI was not found on your PATH. Install it from https://cli.github.com and run `gh auth login`. The GitHub tools need `gh`.",
    );
  }
  if (!isGhAuthed()) {
    throw new GitMeEnvError(
      "gh_not_authed",
      "git-me: `gh` is installed but not authenticated. Run `gh auth login`, then retry. The GitHub tools post as your GitHub identity via `gh`.",
    );
  }
}

// Wipe all caches. Tests only; no production code path calls this.
export function _resetAuthCache(): void {
  repoCache.clear();
  ghAuthedCache = undefined;
}

// Exposed for tests so they can force a TTL miss without sleeping.
export const _REPO_CACHE_MS = REPO_CACHE_MS;

// -------------------------------------------------- subprocess plumbing ----

export interface CmdResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Spawn `git` with the given args, capture stdout/stderr. Never throws. */
export function runGit(args: string[], cwd: string = process.cwd()): CmdResult {
  return spawnChecked("git", args, cwd);
}

/** Spawn `gh` with the given args, capture stdout/stderr. Never throws. */
export function runGh(args: string[], cwd: string = process.cwd()): CmdResult {
  return spawnChecked("gh", args, cwd);
}

// Minimal child_process wrapper. stdin is closed (the agent does not pipe
// input into git/gh from this code). Tests mock via `vi.mock("node:child_process")`.
function spawnChecked(
  cmd: string,
  args: string[],
  cwd: string,
): CmdResult {
  // Synchronous spawn keeps the tool paths linear; git/gh calls are short
  // (sub-second) and the agent is already waiting on the tool result.
  // Async would force every tool to be `async`, which we do anyway, but sync
  // also avoids a "tool returned before stdout" race when reading the result.
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // git/gh should never block on a TTY prompt; 30s is generous.
    timeout: 30_000,
  });
  if (result.error) {
    // ENOENT (binary missing) lands here; surface a clear message.
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { stdout: "", stderr: `git-me: \`${cmd}\` not found on PATH.`, exitCode: 127 };
    }
    return {
      stdout: "",
      stderr: `git-me: failed to spawn \`${cmd}\`: ${result.error.message}`,
      exitCode: 1,
    };
  }
  if (result.signal) {
    // spawnSync killed the child (30s timeout) or it died on a signal.
    // Distinguish from an ordinary non-zero exit so a `gh` call blocking on
    // a credential helper is not mistaken for a git error.
    return {
      stdout: result.stdout ?? "",
      stderr: `git-me: \`${cmd}\` was killed by ${result.signal} (likely the 30s timeout). If \`gh\` was waiting on a credential prompt, authenticate first (\`gh auth login\`).`,
      exitCode: 124,
    };
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}
