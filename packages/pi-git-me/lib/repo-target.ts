// Cross-repo targeting: parse the shared `repo` param and the shared
// refusal texts the remote-surface tools use.
//
// WHY: agents file issues against upstream / third-party repos while
// standing in their own checkout. Targeting used to be implicit (cwd's git
// remotes), so writes landed in the working repo. An explicit slug/URL param
// makes "post THERE" a first-class input that needs no local checkout.

import { remoteWebBase } from "./git";

export type RepoParamResult =
  | { kind: "unset" }
  | { kind: "ok"; slug: string }
  | { kind: "error"; message: string };

export const REPO_CWD_CONFLICT =
  "git-me: pass repo OR cwd, not both: repo targets owner/name directly (no checkout needed); cwd runs inside a local checkout.";

/**
 * "owner/name" | github.com URL -> "owner/name". null when unparseable or
 * not github.com. URL forms reuse remoteWebBase (https, ssh, scp-like, .git,
 * trailing paths). A trailing ".git" on a bare slug is a paste artifact and
 * is stripped; internal dots (vercel/next.js) are kept.
 */
export function normalizeRepoSlug(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9._-]+$/.test(trimmed)) {
    return trimmed.replace(/\.git$/i, "");
  }
  const base = remoteWebBase(trimmed);
  if (!base) return null;
  let host: string;
  let path: string;
  try {
    const u = new URL(base);
    host = u.hostname;
    path = u.pathname;
  } catch {
    return null;
  }
  if (host !== "github.com" && host !== "www.github.com") return null;
  // First char must be alphanumeric in each segment: a slug arg starting
  // with "-" would be flag-parsed by gh (argv arrays stop shell injection,
  // not flag confusion).
  const SEG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
  const [owner = "", name = ""] = path.replace(/^\/+/, "").split("/");
  if (!SEG.test(owner) || !SEG.test(name)) return null;
  return `${owner}/${name}`;
}

export function parseRepoParam(raw: string | undefined): RepoParamResult {
  if (raw === undefined || raw.trim() === "") return { kind: "unset" };
  const slug = normalizeRepoSlug(raw);
  if (!slug) {
    return {
      kind: "error",
      message: `could not parse repo "${raw.trim()}" as owner/name or a github.com URL. Use "owner/name" or "https://github.com/owner/name".`,
    };
  }
  return { kind: "ok", slug };
}

/**
 * Shared execute() preflight for the remote-surface tools: parse `repo`,
 * refuse repo+cwd together. Callers still run requireGitRepo/requireGh
 * themselves (requireGitRepo is skipped when the slug is set: no checkout
 * is needed). Returns null when the params are usable.
 */
export function repoParamConflict(
  params: { repo?: string; cwd?: string },
): string | null {
  const parsed = parseRepoParam(params.repo);
  if (parsed.kind === "error") return `git-me: ${parsed.message}`;
  if (parsed.kind === "ok" && params.cwd !== undefined) {
    return `git-me: ${REPO_CWD_CONFLICT}`;
  }
  return null;
}
