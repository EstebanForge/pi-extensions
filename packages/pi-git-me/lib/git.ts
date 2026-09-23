// High-level git helpers: the curated commands the tools actually run, with
// their stdout/stderr already shaped into the strings the agent renders.
//
// Read tools (status, diff, log, current-branch, pr-info) live here as
// functions returning a single string. Write tools (commit, pr-upsert,
// pr-comment, review-comment, issue-comment) use the confirm gate then call
// these for the apply step.

import { isGitRepo, runGit, runGh } from "./auth";
import type {
  GhPullRequest,
  GhPullRequestFile,
  GitLogEntry,
} from "./types";

// -------------------------------------------------- read helpers -----------

/**
 * Return git working-tree + index status. We use porcelain v1 with branch
 * info (`-b`) so the agent gets the current branch in the same call. Output
 * is capped so a 500-file change set does not blow the context window.
 */
export function gitStatus(cwd: string = process.cwd(), maxLines = 200): string {
  if (!isGitRepo(cwd)) {
    return "not inside a git repository";
  }
  // --branch shows the current branch plus tracking info; --porcelain is the
  // machine-readable 2-char-XY format that the agent can parse if it needs to.
  const result = runGit(["status", "--branch", "--porcelain"], cwd);
  if (result.exitCode !== 0) {
    return result.stderr.trim() || `git status exited ${result.exitCode}`;
  }
  const text = result.stdout.replace(/\n$/, "");
  if (!text) return "clean working tree, nothing to commit";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n... (+${lines.length - maxLines} more)`;
}

/**
 * Return a diff for the given target. Targets map to `git diff` flags:
 *   "staged"  -> --cached (HEAD vs index)
 *   "unstaged" -> working tree vs index (default)
 *   "all"     -> staged + unstaged
 *   "branch"  -> working tree vs <base> (default: main)
 * Capped so an enormous diff does not blow the context window.
 */
export function gitDiff(
  target: "staged" | "unstaged" | "all" | "branch" = "unstaged",
  cwd: string = process.cwd(),
  base = "main",
  maxBytes = 50_000,
): string {
  if (!isGitRepo(cwd)) {
    return "not inside a git repository";
  }
  let args: string[];
  switch (target) {
    case "staged":
      args = ["diff", "--cached"];
      break;
    case "all":
      args = ["diff", "HEAD"];
      break;
    case "branch":
      args = ["diff", `origin/${base}...HEAD`];
      break;
    case "unstaged":
    default:
      args = ["diff"];
      break;
  }
  // --stat gives the agent a summary even when the full diff is truncated.
  args.push("--stat");
  const stat = runGit(args, cwd);
  if (stat.exitCode !== 0) {
    return stat.stderr.trim() || `git diff exited ${stat.exitCode}`;
  }
  // Re-run without --stat for the full patch (so the cap can apply to patch only).
  const patchArgs = args.slice(0, -1);
  const patch = runGit(patchArgs, cwd);
  if (patch.exitCode !== 0) {
    return patch.stderr.trim() || `git diff exited ${patch.exitCode}`;
  }
  const patchText = patch.stdout;
  // Measure in UTF-8 BYTES, not JS string length (UTF-16 code units): a
  // CJK-heavy diff would otherwise overshoot the cap roughly 3x. Slice at a
  // byte boundary so a multibyte character is not split mid-sequence.
  const patchBytes = Buffer.byteLength(patchText, "utf8");
  if (patchBytes <= maxBytes) {
    return patchText || stat.stdout || "(no changes)";
  }
  const truncated = Buffer.from(patchText, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${stat.stdout}\n--- patch truncated (${patchBytes} > ${maxBytes} bytes) ---\n${truncated}\n...`;
}

// Field and record separators for the `git log` format below. Fields are
// separated by 0x01 (`%x01` in the format) and each commit record is
// terminated by 0x00 (`%x00`). NUL-terminating records is what makes
// multi-line commit bodies safe: `%b` can contain any number of newlines,
// and splitting raw stdout on `\n` would turn each body line into a phantom
// entry with undefined hash/date/author. Splitting on `\u0000` keeps one
// record == one commit.
const GIT_LOG_FIELD_SEP = "\u0001";
const GIT_LOG_RECORD_SEP = "\u0000";

/**
 * Parse `git log --format=%H%x01%aI%x01%an%x01%s%x01%b%x00` stdout into
 * structured entries. Pure (no IO) so the multi-line-body case is unit-
 * testable without shelling out to git. Each record is NUL-terminated; within
 * a record the fields are 0x01-separated. The body is everything after the
 * fourth field, joined back and trimmed.
 */
export function parseGitLog(stdout: string): GitLogEntry[] {
  return stdout
    .split(GIT_LOG_RECORD_SEP)
    .filter((rec) => rec !== "")
    .map((rec) => {
      const [hash, isoDate, author, subject, ...bodyParts] =
        rec.split(GIT_LOG_FIELD_SEP);
      return {
        hash,
        isoDate,
        author,
        subject,
        body: bodyParts.join(GIT_LOG_FIELD_SEP).trim(),
      } satisfies GitLogEntry;
    });
}

/**
 * Return the last `limit` commits on the current branch as structured
 * entries (hash, ISO date, author, subject, body). Delegates the stdout ->
 * entries parsing to parseGitLog (pure, unit-tested).
 */
export function gitLog(
  limit = 10,
  cwd: string = process.cwd(),
): GitLogEntry[] {
  if (!isGitRepo(cwd)) return [];
  const fmt = "%H%x01%aI%x01%an%x01%s%x01%b%x00";
  const result = runGit(
    ["log", `-n${Math.max(1, Math.min(limit, 100))}`, `--format=${fmt}`, "--"],
    cwd,
  );
  if (result.exitCode !== 0) return [];
  return parseGitLog(result.stdout);
}

/** Current branch name. Detached HEAD returns "HEAD (detached)". */
export function gitCurrentBranch(cwd: string = process.cwd()): string {
  if (!isGitRepo(cwd)) return "";
  const result = runGit(["symbolic-ref", "--short", "HEAD"], cwd);
  if (result.exitCode === 0) return result.stdout.trim();
  // Detached HEAD: --short fails; fall back to rev-parse for the SHA.
  const detached = runGit(["rev-parse", "--short", "HEAD"], cwd);
  return detached.exitCode === 0 ? `HEAD (detached at ${detached.stdout.trim()})` : "";
}

// -------------------------------------------------- gh helpers ------------

/** Resolve the PR for the current branch. Returns null when there is no PR. */
export function ghPrForCurrentBranch(
  cwd: string = process.cwd(),
): GhPullRequest | null {
  if (!isGitRepo(cwd)) return null;
  // gh pr view falls back to the current branch when no arg is given.
  const result = runGh(
    [
      "pr",
      "view",
      "--json",
      "number,title,body,state,url,baseRefName,headRefName,isDraft,author,reviewDecision",
    ],
    cwd,
  );
  if (result.exitCode !== 0) return null;
  return parseGhPr(result.stdout);
}

// -------------------------------------------------- web URLs ---------------
// The gh-backed write tools surface the URL gh/API reports for the artifact
// they just created (create/edit/GraphQL responses carry it; `gh pr comment`
// and `gh issue comment` print the new comment URL on stdout). The commit
// tool has no such source, so its web URL is derived from the configured
// remote, host-aware (GitHub, GitLab, Bitbucket, Gitea/Codeberg, and a
// generic fallback). Every helper fails soft: null -> callers omit the url
// line instead of erroring.

/**
 * Convert a git remote URL into the repo's web (browser) base URL, e.g.
 * "git@github.com:octo/repo.git" -> "https://github.com/octo/repo". Handles
 * https/http, ssh/git schemes, scp-like syntax, and strips .git. GitLab
 * nested groups pass through unchanged. A custom port is kept for http(s)
 * (the web UI usually lives there) and dropped for ssh (the web UI lives on
 * the standard port even when ssh does not). Returns null when the remote
 * cannot be parsed into a host + path (e.g. a local filesystem path).
 */
export function remoteWebBase(raw: string): string | null {
  const trimmed = raw.trim();
  let host = "";
  let path = "";
  let scheme = "https";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let u: URL;
    try { u = new URL(trimmed); } catch { return null; }
    // Web UIs live on the standard port even when the ssh remote points at a
    // custom one; keep a non-default port only for http(s). Plain-http hosts
    // (self-hosted Gitea on a LAN) keep their scheme too.
    const isHttp = /^https?:$/i.test(u.protocol);
    host = isHttp ? u.host : u.hostname;
    path = u.pathname;
    scheme = u.protocol === "http:" ? "http" : "https";
  } else {
    // Windows drive paths are local filesystem remotes, not scp hosts
    // (the scp regex below would otherwise read "C:" as the host).
    if (/^[a-zA-Z]:[/\\]/.test(trimmed)) return null;
    // scp-like: [user@]host:path (no scheme). The host part cannot contain
    // ":" or "/", so local filesystem paths never match; bracketed IPv6
    // literals ([2001:db8::1]) are allowed as hosts.
    const scp = trimmed.match(/^(?:[^@/]+@)?(\[[0-9a-fA-F:]+\]|[^:/]+):(.+)$/);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
  }
  // Trim slashes around the path, strip a trailing .git, trim again (a path
  // like octo/.git/ leaves a dangling slash after the strip).
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !path) return null;
  return `${scheme}://${host}/${encodeURI(path)}`;
}

/**
 * Commit web URL from a repo web base + sha. bitbucket.org serves commits
 * under /commits/<sha>; GitHub, GitLab, Gitea/Codeberg (and most other
 * forge software) serve /commit/<sha>.
 */
export function commitUrlFromBase(base: string, sha: string): string {
  let host = "";
  try { host = new URL(base).hostname; } catch { /* unknown host -> generic path */ }
  const seg = host === "bitbucket.org" ? "commits" : "commit";
  return `${base.replace(/\/+$/, "")}/${seg}/${sha}`;
}

/**
 * Web URL for a commit in the repo at cwd, derived from the configured
 * remote (origin first, else the first listed remote). null when there is
 * no remote, it cannot be parsed, or the sha is empty - callers omit the
 * url line rather than erroring.
 */
export function gitCommitWebUrl(cwd: string, sha: string): string | null {
  if (!sha) return null;
  let remote = runGit(["remote", "get-url", "origin"], cwd);
  if (remote.exitCode !== 0) {
    const list = runGit(["remote"], cwd);
    if (list.exitCode !== 0) return null;
    const first = list.stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!first) return null;
    remote = runGit(["remote", "get-url", first], cwd);
  }
  if (remote.exitCode !== 0) return null;
  const base = remoteWebBase(remote.stdout);
  return base === null ? null : commitUrlFromBase(base, sha);
}

/**
 * First http(s) URL in gh stdout, e.g. the comment URL `gh pr comment`
 * prints after a successful post. Trailing sentence punctuation is trimmed
 * so a URL embedded in prose still opens. null when stdout carries no URL.
 */
export function extractUrl(stdout: string): string | null {
  const m = stdout.match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[.,:;!?)'\"]+$/, "") : null;
}

/**
 * Web URL for a PR by number (`gh pr view <n> --json url`). null on any
 * failure - callers omit the url line rather than erroring.
 */
export function ghPrUrlByNumber(number: number, cwd: string): string | null {
  const result = runGh(["pr", "view", String(number), "--json", "url"], cwd);
  if (result.exitCode !== 0) return null;
  try {
    const url = (JSON.parse(result.stdout) as { url?: unknown }).url;
    return typeof url === "string" && url ? url : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------- gh JSON parsing --------

// Narrow gh's JSON envelope before casting to the typed shape. gh's output is
// trusted, so the guards check only the minimum keys the downstream callers
// actually read. A malformed response returns null/empty rather than crashing
// the agent.

export function parseGhPr(raw: string): GhPullRequest | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.number !== "number" || typeof o.url !== "string") return null;
  return o as unknown as GhPullRequest;
}

export function parseGhFiles(raw: string): GhPullRequestFile[] {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return []; }
  if (typeof obj !== "object" || obj === null) return [];
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.files)) return [];
  // The cast is bounded by the array check above; each entry is taken on
  // trust because gh emits a stable shape.
  return o.files as GhPullRequestFile[];
}
