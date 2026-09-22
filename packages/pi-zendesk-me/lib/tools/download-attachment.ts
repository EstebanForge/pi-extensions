import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { zdDownload, zdGet } from "../api";
import { toToolResult, errorText, type ZendeskDetails } from "../result";
import type { ZdAttachment, ZdCommentsResponse } from "../types";
import { parseTicketRef, TICKET_REF_EXAMPLE } from "../url";
import {
  DOWNLOAD_DESCRIPTION,
  DOWNLOAD_PARAM_ID,
  DOWNLOAD_PARAM_TICKET,
  DOWNLOAD_TITLE,
} from "../prompts";

const Params = Type.Object({
  ticket: Type.String({ description: DOWNLOAD_PARAM_TICKET }),
  attachment: Type.Number({ description: DOWNLOAD_PARAM_ID }),
});

// Filenames land in a shared temp dir; strip any path components and unsafe
// characters. Attachment id prefixes the name so repeated downloads of
// same-named files never collide.
function sanitizeFileName(name: string): string {
  const base = path.basename(name || "attachment").replace(
    /[^A-Za-z0-9._-]/g,
    "_",
  );
  const capped = base.length > 120 ? base.slice(-120) : base;
  return capped || "attachment";
}

// Every attachment on the ticket, inline or not, for the not-found error.
function listAttachments(
  resp: ZdCommentsResponse,
): Array<{ attachment: ZdAttachment; commentId: number }> {
  const found: Array<{ attachment: ZdAttachment; commentId: number }> = [];
  for (const comment of resp.comments ?? []) {
    for (const attachment of comment.attachments ?? []) {
      found.push({ attachment, commentId: comment.id });
    }
  }
  return found;
}

export const downloadAttachmentTool: ToolDefinition<
  typeof Params,
  ZendeskDetails
> = {
  name: "zendesk_download_attachment",
  label: DOWNLOAD_TITLE,
  description: DOWNLOAD_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<ZendeskDetails>> {
    const id = parseTicketRef(params.ticket);
    if (id === null) {
      return toToolResult(
        `Invalid ticket reference: ${JSON.stringify(params.ticket)}. ` +
          `Pass ${TICKET_REF_EXAMPLE}.`,
      );
    }

    try {
      const resp = await zdGet<ZdCommentsResponse>(
        `tickets/${id}/comments.json`,
      );
      const match = listAttachments(resp).find(
        (entry) => entry.attachment.id === params.attachment,
      );

      if (!match) {
        const available = listAttachments(resp);
        const listing = available.length
          ? available
              .map(
                (entry) =>
                  `#${entry.attachment.id} ${entry.attachment.file_name} (comment #${entry.commentId})`,
              )
              .join(", ")
          : "none on this ticket";
        return toToolResult(
          `Attachment ${params.attachment} not found on ticket ${id}. ` +
            `Available attachments: ${listing}.`,
        );
      }

      const { attachment } = match;
      if (!attachment.content_url) {
        return toToolResult(
          `Attachment ${attachment.id} (${attachment.file_name}) has no ` +
            "content URL; it cannot be downloaded.",
        );
      }

      const { bytes, contentType } = await zdDownload(attachment.content_url);

      const dir = path.join(tmpdir(), "pi-zendesk-me");
      await mkdir(dir, { recursive: true });
      const filePath = path.join(
        dir,
        `${attachment.id}-${sanitizeFileName(attachment.file_name)}`,
      );
      await writeFile(filePath, bytes);

      return toToolResult(
        [
          `Downloaded: ${filePath}`,
          `File: ${attachment.file_name} (${bytes.byteLength} bytes` +
            `${contentType ? `, ${contentType}` : ""}) from comment #${match.commentId}.`,
          "Images (png/jpg/gif/webp): view with the native `read` tool on this path.",
        ].join("\n"),
      );
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
