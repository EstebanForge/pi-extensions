// GitHub API plumbing beyond the plain `gh <noun> <verb>` commands.
//
// `gh issue create`, `gh pr comment`, etc. are first-class CLI commands, but
// GitHub Discussions have NO gh command (no `gh discussion create`). The
// Discussions API surface is GraphQL-only (plus a few REST read paths), so
// the discussion tools reach it through `gh api graphql` / `gh api`.
//
// Everything here shells out through the same runGh() the other tools use
// (spawnSync, args array, no shell interpolation), so variable values are
// never re-parsed by a shell and cannot inject GraphQL syntax.

import { runGh } from "./auth";

/** Repository identity: GraphQL node ID + owner/name split for queries. */
export interface GhRepoRef {
  /** GraphQL node ID (e.g. "MDEwOlJlcG9zaXRvcnk..."). Required by mutations. */
  id: string;
  owner: string;
  name: string;
  /** "owner/name" as gh prints it. Used for REST paths and human labels. */
  nameWithOwner: string;
}

/**
 * Resolve the repository for a working directory via
 * `gh repo view --json id,nameWithOwner`. Returns null when gh fails (no
 * GitHub remote, not authed, network down) — callers turn that into an
 * actionable message. requireGh() should run first so "gh missing" is
 * already ruled out.
 */
export function ghRepoView(cwd: string): GhRepoRef | null {
  const result = runGh(["repo", "view", "--json", "id,nameWithOwner"], cwd);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { id?: string; nameWithOwner?: string };
    if (!parsed.id || !parsed.nameWithOwner) return null;
    const [owner, name] = parsed.nameWithOwner.split("/");
    if (!owner || !name) return null;
    return { id: parsed.id, owner, name, nameWithOwner: parsed.nameWithOwner };
  } catch {
    return null;
  }
}

/** Error carrying the first GraphQL `errors[]` message when present. */
export class GhGraphqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhGraphqlError";
  }
}

/**
 * Run a GraphQL query/mutation via `gh api graphql`. Variables are passed as
 * `-F key=value` flags (gh type-converts numeric strings to Int/Float, which
 * matches GraphQL scalar expectations; args-array spawn means no quoting
 * hazards). Returns the `data` object. Throws GhGraphqlError on a non-zero
 * exit OR a 200 body carrying `errors` (gh usually fails the exit code on
 * GraphQL errors, but a body-level check keeps us honest).
 */
export function ghGraphql(
  query: string,
  variables: Record<string, string | number>,
  cwd: string,
): Record<string, unknown> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push("-F", `${key}=${value}`);
  }
  const result = runGh(args, cwd);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new GhGraphqlError(
      `git-me: \`gh api graphql\` failed (exit ${result.exitCode}). ${detail}`,
    );
  }
  let parsed: { data?: Record<string, unknown>; errors?: Array<{ message?: string }> };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new GhGraphqlError(
      `git-me: \`gh api graphql\` returned non-JSON output. First 200 bytes: ${result.stdout.slice(0, 200)}`,
    );
  }
  if (parsed.errors && parsed.errors.length > 0) {
    throw new GhGraphqlError(
      `git-me: GitHub API error: ${parsed.errors[0]?.message ?? "unknown GraphQL error"}`,
    );
  }
  return parsed.data ?? {};
}

// -------------------------------------------------- discussion queries -----
// Named operations make the mock-routed tests (and gh verbose logs) readable.

export const DISCUSSION_CATEGORIES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    discussionCategories(first: 50) {
      nodes { id name }
    }
  }
}`;

export const CREATE_DISCUSSION_MUTATION = `mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
  createDiscussion(input: {repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body}) {
    discussion { number url }
  }
}`;

export const DISCUSSION_BY_NUMBER_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      id
      title
      url
    }
  }
}`;

export const ADD_DISCUSSION_COMMENT_MUTATION = `mutation($discussionId: ID!, $body: String!, $replyToId: ID) {
  addDiscussionComment(input: {discussionId: $discussionId, body: $body, replyToId: $replyToId}) {
    comment { url }
  }
}`;

// -------------------------------------------------- discussion shapes ------

export interface DiscussionCategory {
  id: string;
  name: string;
}

/** Extract category nodes from the DISCUSSION_CATEGORIES_QUERY result. */
export function parseDiscussionCategories(
  data: Record<string, unknown>,
): DiscussionCategory[] {
  const repo = data.repository as
    | { discussionCategories?: { nodes?: Array<{ id?: string; name?: string }> } }
    | undefined;
  const nodes = repo?.discussionCategories?.nodes ?? [];
  return nodes.flatMap((n) => (n.id && n.name ? [{ id: n.id, name: n.name }] : []));
}

export interface DiscussionRef {
  /** GraphQL node ID ("MDEwOkRpc2N1c3Npb24..." / "DIC..."). */
  id: string;
  title: string;
  url: string;
}

/** Extract a discussion from the DISCUSSION_BY_NUMBER_QUERY result. null = no such discussion. */
export function parseDiscussion(
  data: Record<string, unknown>,
): DiscussionRef | null {
  const repo = data.repository as { discussion?: { id?: string; title?: string; url?: string } } | undefined;
  const d = repo?.discussion;
  if (!d || !d.id || !d.url) return null;
  return { id: d.id, title: d.title ?? "", url: d.url };
}

/**
 * Resolve a `replyTo` comment reference to the GraphQL node ID the
 * addDiscussionComment mutation needs. Accepts either shape the agent can
 * discover read-only:
 *   - a REST numeric comment id (from `gh api repos/.../discussions/N/comments`)
 *     -> resolved to node_id via one REST GET
 *   - a GraphQL node id already (from a GraphQL listing) -> used as-is
 */
export function resolveDiscussionCommentNodeId(
  replyTo: string,
  repo: GhRepoRef,
  cwd: string,
): { nodeId: string } | { error: string } {
  if (/^\d+$/.test(replyTo)) {
    const result = runGh(
      ["api", `repos/${repo.nameWithOwner}/discussions/comments/${replyTo}`, "--jq", ".node_id"],
      cwd,
    );
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      return {
        error: `git-me: comment ${replyTo} not found in ${repo.nameWithOwner} (could not resolve it to a reply target). ${detail}`,
      };
    }
    const nodeId = result.stdout.trim();
    if (!nodeId) {
      return { error: `git-me: comment ${replyTo} resolved to an empty id; nothing was posted.` };
    }
    return { nodeId };
  }
  return { nodeId: replyTo };
}
