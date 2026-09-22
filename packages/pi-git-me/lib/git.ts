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
