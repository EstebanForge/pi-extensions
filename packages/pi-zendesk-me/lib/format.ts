import type {
  ZdComment,
  ZdOrganization,
  ZdTicket,
  ZdUser,
} from "./types";

// Formatting helpers shared by the tools. Output targets an LLM: plain text,
// stable field order, ids alongside resolved names so the agent can follow up
// with zendesk_get_user / zendesk_get_organization without re-fetching.

export interface SideLoadMaps {
  users: Map<number, ZdUser>;
  organizations: Map<number, ZdOrganization>;
}

export function buildSideLoadMaps(
  users?: ZdUser[],
  organizations?: ZdOrganization[],
): SideLoadMaps {
  return {
    users: new Map((users ?? []).map((u) => [u.id, u])),
    organizations: new Map((organizations ?? []).map((o) => [o.id, o])),
  };
}

// "Ada Lovelace <ada@example.com>" when an email exists, "Ada Lovelace"
// otherwise, "#123 (unknown user)" when side-loading missed the record.
export function userName(maps: SideLoadMaps, id: number | null): string {
  if (id === null || id === undefined) return "unassigned";
  const user = maps.users.get(id);
  if (!user) return `#${id}`;
  return user.email ? `${user.name} <${user.email}>` : user.name;
}

export function orgName(maps: SideLoadMaps, id: number | null): string {
  if (id === null || id === undefined) return "none";
  const org = maps.organizations.get(id);
  return org ? org.name : `#${id}`;
}

// "2026-07-14 15:03 UTC" from a Zendesk ISO timestamp. UTC everywhere: the
// agent compares timestamps across tools, so no locale math.
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "n/a";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

// Comment and description bodies arrive as HTML. The agent must not paste raw
// HTML at the user, so tools render stripped plain text (prefer plain_body
// when Zendesk supplies it). Full fidelity stays one call away: the raw field
// is echoed in the details the agent can quote when needed.
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ");
  const withoutTags = withBreaks.replace(/<[^>]*>/g, "");
  const decoded = withoutTags.replace(
    /&(amp|lt|gt|quot|#39|apos|nbsp);/g,
    (entity) => ENTITY_MAP[entity] ?? entity,
  );
  // Collapse >2 blank lines from block-tag expansion; trim leading pad.
  return decoded
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text: string, max = 1500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}... [truncated, ${text.length - max} chars]`;
}

export function formatTicketLine(
  ticket: ZdTicket,
  maps: SideLoadMaps,
): string {
  const bits = [
    `#${ticket.id}`,
    `[${ticket.status}]`,
    ticket.subject ?? "(no subject)",
  ];
  if (ticket.priority && ticket.priority !== "normal") {
    bits.push(`(${ticket.priority})`);
  }
  bits.push(`- requester: ${userName(maps, ticket.requester_id)}`);
  return bits.join(" ");
}

export function formatComment(
  comment: ZdComment,
  maps: SideLoadMaps,
): string {
  const visibility = comment.public ? "public reply" : "INTERNAL NOTE";
  const channel = comment.via?.channel ? ` via ${comment.via.channel}` : "";
  const header = `- ${formatDate(comment.created_at)} - ${userName(
    maps,
    comment.author_id,
  )} - ${visibility}${channel} [comment #${comment.id}]`;
  const body = truncate(stripHtml(comment.body ?? comment.html_body), 1500);
  const attachments = (comment.attachments ?? []).filter((a) => !a.inline);
  const attachmentLines = attachments.length
    ? [
        "",
        ...attachments.map(
          (a) =>
            `  attachment: #${a.id} ${a.file_name}${
              a.size ? ` (${a.size} bytes)` : ""
            }`,
        ),
      ]
    : [];
  return [header, body || "(empty)", ...attachmentLines].join("\n");
}
