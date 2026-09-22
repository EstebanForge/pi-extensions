// User ID -> display name resolution with an in-memory cache. Slack message
// payloads carry raw user IDs (U...); resolving them to a human-readable name
// makes feedback and threads far more legible to the agent and to the user.
//
// The cache is process-scoped (one pi session). users.info is Tier 3
// (~50+/min), so a miss is cheap, but reading the same channel twice should
// never re-hit the API. Mirrors the resolveUserName pattern proven in
// arvore/slack-watcher.

import { slackGet } from "./api";
import type { SlackUser } from "./types";

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

// Resolve a single user ID to the best available name. Priority:
// profile.display_name &rarr; profile.real_name &rarr; user.name &rarr; raw ID.
// Failures (deleted users, API hiccups) fall back to the raw ID so reading a
// channel never breaks on one unresolvable author.
export async function resolveUserName(userId: string): Promise<string> {
  if (!userId) return "unknown";
  const cached = cache.get(userId);
  if (cached) return cached;

  // Dedupe concurrent lookups for the same ID.
  let p = pending.get(userId);
  if (!p) {
    p = (async () => {
      try {
        const resp = await slackGet<{ user?: SlackUser }>("users.info", {
          query: { user: userId },
        });
        const u = resp.user;
        const name =
          u?.profile?.display_name ||
          u?.profile?.real_name ||
          u?.real_name ||
          u?.name ||
          userId;
        cache.set(userId, name);
        return name;
      } catch {
        cache.set(userId, userId);
        return userId;
      } finally {
        pending.delete(userId);
      }
    })();
    pending.set(userId, p);
  }
  return p;
}

// Resolve many user IDs in parallel (used by message list formatting when a
// page has many distinct authors). Order of input is preserved in output.
export async function resolveUserNames(userIds: string[]): Promise<string[]> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const results = await Promise.all(unique.map(resolveUserName));
  const map = new Map(unique.map((id, i) => [id, results[i] as string]));
  return userIds.map((id) => map.get(id) ?? "unknown");
}

// Wipe the cache. Tests only.
export function _resetUserCache(): void {
  cache.clear();
  pending.clear();
}
