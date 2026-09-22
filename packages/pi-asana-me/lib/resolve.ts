// Best-effort GID -> human label resolver, used ONLY by the write-review gate
// to show a task's name + permalink in the confirm dialog instead of a bare
// GID. Resolves before the prompt is shown, and only when a prompt will
// actually be shown (gate on + interactive UI), so the headless / gate-off
// fast paths never pay for it. Nothing here blocks a write: any per-GID
// failure (404, rate limit, network) is swallowed and the caller falls back
// to the raw GID.

import { callAsana } from "./api";

export interface ResolvedRef {
  name?: string;
  permalink_url?: string;
}

// Resolve a set of task GIDs to {name, permalink_url}. Dedupes input so a
// batch that repeats a gid (or reuses one as both task and parent) hits Asana
// once. Promise.all fans the (small) GET set out concurrently; each call is
// independently guarded so one 404 can't fail the whole batch. Returns a Map
// keyed by gid; missing entries = unresolved (caller falls back to the gid).
export async function resolveTasks(
  gids: Iterable<string>,
): Promise<Map<string, ResolvedRef>> {
  const unique = [...new Set([...gids].filter((g): g is string => !!g))];
  if (unique.length === 0) return new Map();

  const entries = await Promise.all(
    unique.map(async (gid) => {
      try {
        const t = await callAsana<ResolvedRef>(
          "GET",
          `/tasks/${encodeURIComponent(gid)}`,
          { query: { opt_fields: "name,permalink_url" } },
        );
        return [gid, { name: t.name, permalink_url: t.permalink_url }] as const;
      } catch {
        // Unresolved (deleted task, no access, transient error). The caller
        // keeps the raw gid, so a resolve miss never blocks a write.
        return null;
      }
    }),
  );

  const out = new Map<string, ResolvedRef>();
  for (const e of entries) {
    if (e) out.set(e[0], e[1]);
  }
  return out;
}

// Render a resolved task for a confirm dialog: '<name>' (<url>) when fully
// resolved, '<name>' (gid: <gid>) when named but URL-less, and a bare
// `gid: <gid>` fallback so the human always has *something* to verify.
export function fmtTask(gid: string, r?: ResolvedRef): string {
  const name = r?.name?.trim();
  const url = r?.permalink_url;
  if (name && url) return `'${name}' (${url})`;
  if (name) return `'${name}' (gid: ${gid})`;
  return `gid: ${gid}`;
}
