// Compact, line-oriented formatters. Every Slack tool renders its payload to a
// short text string: one line per message, one line per channel, etc. This is
// the primary context-pollution control - the agent reads summarized prose,
// not raw Slack JSON.
//
// User IDs are resolved to display names before rendering (see resolveUserNames)
// so feedback shows authors, not U... literals.

import type {
  SlackChannel,
  SlackFileInfo,
  SlackMessage,
  SlackSearchMatch,
  SlackSearchResult,
} from "./types";
import { resolveUserNames } from "./users";

// channels ---------------------------------------------------------------

export function formatChannelList(channels: SlackChannel[]): string {
  if (channels.length === 0) return "No channels found.";

  const lines = channels.map((ch) => {
    const marker = ch.is_im ? "✉️" : ch.is_mpim ? "👥" : ch.is_private ? "🔒" : "#";
    const name = ch.is_im ? `DM with ${ch.user ?? "?"}` : ch.name;
    const members =
      typeof ch.num_members === "number" ? ` · ${ch.num_members} members` : "";
    const topic = ch.topic?.value ? ` — ${ch.topic.value}` : "";
    return `${marker} **${name}** (${ch.id})${members}${topic}`;
  });

  return `**Channels** (${channels.length}):\n\n${lines.join("\n")}`;
}

// messages ----------------------------------------------------------------

function formatTimestamp(ts: string): string {
  const seconds = Number(ts);
  if (Number.isNaN(seconds)) return ts;
  return new Date(seconds * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

// Format a list of messages once author names are known. names[i] aligns with
// messages[i]. Public so the download-file tool can reuse the single-message
// path, but callers normally go through formatMessages / formatThread which
// resolve names internally.
export function formatMessagesWithNames(
  messages: SlackMessage[],
  names: string[],
  title: string,
  hasMore?: boolean,
): string {
  if (messages.length === 0) return `${title}: no messages found.`;

  const header = `**${title}** (${messages.length}${hasMore ? ", more available" : ""}):`;
  const lines = messages.map((msg, i) => {
    const time = formatTimestamp(msg.ts);
    const author = names[i] ?? msg.username ?? "unknown";
    const thread = msg.reply_count ? ` [${msg.reply_count} replies]` : "";
    const reactions = msg.reactions?.length
      ? ` ${msg.reactions.map((r) => `:${r.name}: ${r.count}`).join(" ")}`
      : "";
    const files = msg.files?.length
      ? `\n  📎 ${msg.files.map((f) => `${f.name} (${f.id})`).join(", ")}`
      : "";
    return `[${time}] **${author}**${thread}: ${msg.text ?? ""}${reactions}${files}`;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
}

export async function formatMessages(
  messages: SlackMessage[],
  channelId: string,
  hasMore?: boolean,
): Promise<string> {
  const names = await resolveUserNames(
    messages.map((m) => m.user ?? "unknown"),
  );
  return formatMessagesWithNames(messages, names, `Messages in ${channelId}`, hasMore);
}

export async function formatThread(
  messages: SlackMessage[],
  channelId: string,
  threadTs: string,
  hasMore?: boolean,
): Promise<string> {
  const names = await resolveUserNames(
    messages.map((m) => m.user ?? "unknown"),
  );
  return formatMessagesWithNames(
    messages,
    names,
    `Thread ${threadTs} in ${channelId}`,
    hasMore,
  );
}

// search ------------------------------------------------------------------

export async function formatSearchResults(
  result: SlackSearchResult,
  query: string,
): Promise<string> {
  if (result.matches.length === 0) return `No results found for "${query}".`;

  const names = await resolveUserNames(
    result.matches.map((m) => m.user ?? "unknown"),
  );
  const header = `**Search results** for "${query}" (${result.matches.length} of ${result.total} total):`;
  const lines = result.matches.map((m, i) => {
    const time = formatTimestamp(m.ts);
    const author = names[i] ?? m.username ?? "unknown";
    const chan = m.channel.name ?? m.channel.id;
    return `[${time}] **${author}** in #${chan}: ${m.text ?? ""}\n  🔗 ${m.permalink}`;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
}

// files -------------------------------------------------------------------

export function formatFileSize(bytes?: number): string {
  if (typeof bytes !== "number") return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDownloadedFile(
  info: SlackFileInfo,
  localPath: string,
): string {
  const size = formatFileSize(info.size);
  const isImage = info.mimetype?.startsWith("image/") ?? false;
  const hint = isImage
    ? `\n\n💡 This is an image. Use the \`read\` tool to view it:\n  \`read ${localPath}\``
    : `\n\n📁 Downloaded to: ${localPath}`;
  const link = info.permalink ? `\n  🔗 ${info.permalink}` : "";
  return `📎 **${info.title ?? info.name ?? info.id}** (${info.name ?? "?"})\n  Type: ${info.mimetype ?? info.filetype ?? "?"} · Size: ${size}${link}${hint}`;
}
