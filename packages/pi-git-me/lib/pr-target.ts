// Wrong-target hardening for the PR write tools (incident 2026-11-11).
//
// A bare `gh pr view` resolves "the PR for the current branch" opaquely and
// state-dependently; in the incident it handed back a CLOSED PR on a
// different branch pair and the write landed on it. The primitives here make
// wrong targets structurally impossible:
//
//   - resolvePrForBranch: branch-bound resolution pins `--head <branch>` on
//     the wire, filters to OPEN state in code, and only binds a PR whose
//     headRefName equals the checked-out branch. Anything else is none /
//     closed / ambiguous / mismatch, all refused upstream.
//   - ghPrByNumber: number-pinned snapshot fetch (the only acceptable apply
//     shape).
//   - verifyPrTarget: apply-time identity check. The human approves a
//     target at gate time; a human can merge, close, retarget, or rebase
//     that PR while the dialog is open, so every write re-fetches by number
//     right before the gh call and aborts on any drift in state, head,
//     base, or repo.
//
// Read tools keep lib/git.ts's raw `ghPrViewCurrentBranch` (closed PRs are
// legitimate display targets); write tools must come through this module.

import { runGh } from "./auth";
import { gitCurrentBranch, parseGhPr } from "./git";
import { ghRepoView } from "./github";
import type { GhPullRequest } from "./types";

const PR_JSON_FIELDS =
  "number,title,body,state,url,baseRefName,headRefName,isDraft,author,reviewDecision,headRepositoryOwner,isCrossRepository";

/**
 * Result of branch-bound PR resolution for a write tool.
 *   ok        — exactly one OPEN PR whose headRefName equals the checked-out
 *               branch and whose head repo is this checkout's repo; the only
 *               bindable shape.
 *   none      — no PR for this head (or no branch / foreign-fork rows
 *               skipped): not bound.
 *   closed    — PR(s) exist for this head but are CLOSED or MERGED.
 *   ambiguous — several OPEN PRs share this head; the tool cannot pick.
 *   mismatch  — gh handed back a PR whose head is not the checked-out
 *               branch; refuse with the full identity.
 *   error     — gh failed or answered garbage; refusing beats guessing.
 */
export type BranchPrResolution =
  | { kind: "ok"; pr: GhPullRequest; branch: string }
  | { kind: "none"; branch: string | null }
  | { kind: "closed"; pr: GhPullRequest; branch: string }
  | { kind: "ambiguous"; prs: GhPullRequest[]; branch: string }
  | { kind: "mismatch"; pr: GhPullRequest; branch: string }
  | { kind: "error"; branch: string | null; detail: string };

function isPrRow(value: unknown): value is GhPullRequest {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.number === "number" && typeof o.url === "string";
}

/**
 * Checked-out branch name for dialog labels. null when there is no branch
 * (detached HEAD, git failure) — callers omit the branch part of the label.
 */
export function branchLabel(cwd: string): string | null {
  const branch = gitCurrentBranch(cwd);
  return branch && !branch.startsWith("HEAD (detached") ? branch : null;
}

/**
 * Resolve the PR a branch-bound write may touch. The gh argv carries the
 * branch explicitly (`--head <branch> --state all`); state filtering and the
 * headRefName equality check happen here, so gh's opaque matching can only
 * affect which rows enter the list, never which PR gets bound.
 */
export function resolvePrForBranch(cwd: string): BranchPrResolution {
  const branch = branchLabel(cwd);
  if (!branch) {
    return { kind: "none", branch: null };
  }
  const result = runGh(
    ["pr", "list", "--head", branch, "--state", "all", "--json", PR_JSON_FIELDS, "--limit", "50"],
    cwd,
  );
  // gh pr list --head filters by bare branch name across all forks, so a
  // cross-repository row binds only when its head owner is the repo gh
  // resolves in this checkout. Same-repo rows (isCrossRepository false or
  // absent) are unambiguous without the lookup; when ghRepoView fails, all
  // cross-repo rows are skipped (fail closed).
  if (result.exitCode !== 0) {
    return { kind: "error", branch, detail: `gh pr list exited ${result.exitCode}` };
  }
  let rows: GhPullRequest[];
  try {
    // Real gh prints nothing (exit 0) when --head matches no PRs; empty
    // stdout is "no rows", not garbage.
    const parsed: unknown = result.stdout.trim() ? JSON.parse(result.stdout) : [];
    rows = Array.isArray(parsed) ? parsed.filter(isPrRow) : [];
  } catch {
    return { kind: "error", branch, detail: "gh pr list returned malformed JSON" };
  }
  if (rows.some((r) => r.isCrossRepository)) {
    const ref = ghRepoView(cwd);
    rows = rows.filter(
      (r) => !r.isCrossRepository || (ref !== null && r.headRepositoryOwner?.login === ref.owner),
    );
  }
  const mismatched = rows.find((r) => r.headRefName !== branch);
  if (mismatched) return { kind: "mismatch", pr: mismatched, branch };
  const open = rows.filter((r) => r.state === "OPEN");
  if (open.length === 0) {
    const closed = rows[0];
    return closed ? { kind: "closed", pr: closed, branch } : { kind: "none", branch };
  }
  if (open.length > 1) return { kind: "ambiguous", prs: open, branch };
  return { kind: "ok", pr: open[0], branch };
}

/**
 * Refusal text for every resolution a write tool must refuse on. null for
 * ok (proceed) and none (callers keep their own "no PR" guidance, which
 * pr-upsert maps to the create path).
 */
export function branchPrRefusal(res: BranchPrResolution): string | null {
  switch (res.kind) {
    case "ok":
    case "none":
      return null;
    case "closed":
      return `git-me: PR #${res.pr.number} on branch "${res.branch}" is ${res.pr.state} (${res.pr.headRefName} -> ${res.pr.baseRefName}). A closed or merged PR is never a current-branch write target. Pass \`pr\` explicitly to target it on purpose.`;
    case "mismatch": {
      return `git-me: gh resolved PR #${res.pr.number} (${res.pr.headRefName} -> ${res.pr.baseRefName}) while the checked-out branch is "${res.branch}", but the PR head does not match that branch. Refusing: pass \`pr\` explicitly to target a PR on purpose.`;
    }
    case "error": {
      return `git-me: branch PR resolution failed (${res.detail}). Refusing rather than guessing: check gh auth and connectivity, or pass \`pr\` explicitly to target a PR on purpose.`;
    }
    case "ambiguous": {
      const list = res.prs.map((p) => `#${p.number} -> ${p.baseRefName}`).join(", ");
      return `git-me: branch "${res.branch}" has ${res.prs.length} open PRs (${list}). Pass \`pr\` explicitly to choose one.`;
    }
  }
}

/**
 * Number-pinned PR snapshot: `gh pr view <n> [-R slug] --json <fields>`.
 * null when gh fails or the response is malformed — callers refuse.
 */
export function ghPrByNumber(
  number: number,
  cwd: string,
  slug?: string,
): GhPullRequest | null {
  const args = ["pr", "view", String(number), "--json", PR_JSON_FIELDS];
  if (slug) args.push("-R", slug);
  const result = runGh(args, cwd);
  if (result.exitCode !== 0) return null;
  return parseGhPr(result.stdout);
}

export type PrTargetVerification = { ok: true } | { ok: false; message: string };

/** "owner/name" from a canonical PR web URL; null when it does not parse. */
function repoSlugFromPrUrl(url: string): string | null {
  const m = url.match(/\/([^/]+)\/([^/]+)\/pull\/\d+$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Apply-time target check. Re-fetches the PR by explicit number and compares
 * the full identity the gate showed (state, head, base, repo). Any drift
 * between gate approval and apply aborts the write with the old -> new pair
 * named; nothing is sent to gh.
 */
export function verifyPrTarget(
  expected: GhPullRequest,
  cwd: string,
  slug?: string,
): PrTargetVerification {
  const fresh = ghPrByNumber(expected.number, cwd, slug);
  if (!fresh) {
    return {
      ok: false,
      message: `git-me: PR #${expected.number} could not be re-fetched for the apply-time target check (\`gh pr view ${expected.number}\` failed). Nothing was sent; re-resolve the target and retry.`,
    };
  }
  const drifts: string[] = [];
  if (expected.state !== fresh.state) {
    drifts.push(`state changed ${expected.state} -> ${fresh.state}`);
  }
  if (expected.headRefName !== fresh.headRefName) {
    drifts.push(`head changed ${expected.headRefName} -> ${fresh.headRefName}`);
  }
  if (expected.baseRefName !== fresh.baseRefName) {
    drifts.push(`base changed ${expected.baseRefName} -> ${fresh.baseRefName}`);
  }
  const before = repoSlugFromPrUrl(expected.url);
  const after = repoSlugFromPrUrl(fresh.url);
  if (before && after && before !== after) {
    drifts.push(`repo changed ${before} -> ${after}`);
  }
  if (drifts.length > 0) {
    return {
      ok: false,
      message: `git-me: PR #${expected.number} changed while the dialog was open (${drifts.join("; ")}). Nothing was sent: the approved target is stale. Re-resolve the target and retry.`,
    };
  }
  return { ok: true };
}

/**
 * Full target identity for gate titles: repo goes through gateRepoSuffix at
 * the call site; this renders "PR #7 (OPEN, feat -> main[, branch "feat"])".
 */
export function prTargetLabel(pr: GhPullRequest, branch?: string | null): string {
  const parts = [pr.state, `${pr.headRefName} -> ${pr.baseRefName}`];
  if (branch) parts.push(`branch "${branch}"`);
  return `PR #${pr.number} (${parts.join(", ")})`;
}
