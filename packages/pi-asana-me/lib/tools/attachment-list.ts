import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsanaPaged, AsanaError } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaAttachment } from "../types";
import {
  ATTACHMENTS_LIST_TITLE,
  ATTACHMENTS_LIST_DESCRIPTION,
  ATTACHMENTS_LIST_TASK_GID_DESCRIPTION,
} from "../prompts";

// List the attachments on a task. Two attachment flavors share this endpoint:
//   - files explicitly uploaded to the task (XLS/CSV/PDF/ZIP/...)
//   - images pasted INLINE into a comment thread (Asana stores those as
//     attachments on the task too; the comment body just references them)
// Both surface here with a gid, so the agent can hand the gid to
// asana_download_attachment. This tool returns METADATA only - never binary -
// to keep the payload cheap and the agent's context clean. Binary fetch is
// opt-in via the download tool.
//
// Endpoint: GET /tasks/{task_gid}/attachments. Mirrors the /tasks/{gid}/stories
// shape used by asana_get_task_comments: a {data: [...], next_page} envelope we
// page through. opt_fields asks for the host + download_url so the renderer can
// tell the agent up front whether a download will succeed (asana-host) or only
// hand back a browser URL (external host like gdrive/dropbox).

const MAX_PAGES = 10; // 10 * 100 = 1000; matches the stories pagination cap.

const OPT_FIELDS = [
  "name",
  "resource_subtype",
  "host",
  "download_url",
  "view_url",
  "size",
  "created_at",
  "created_by.name",
  "parent.name",
].join(",");

const Params = Type.Object({
  task_gid: Type.String({ description: ATTACHMENTS_LIST_TASK_GID_DESCRIPTION }),
});

function humanSize(bytes: number | null | undefined): string {
  if (bytes == null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const listAttachmentsTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_list_attachments",
  label: ATTACHMENTS_LIST_TITLE,
  description: ATTACHMENTS_LIST_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    try {
      const collected: AsanaAttachment[] = [];
      let offset: string | undefined;
      let hitCap = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await callAsanaPaged<AsanaAttachment[]>(
          "GET",
          `/tasks/${encodeURIComponent(params.task_gid)}/attachments`,
          { query: { opt_fields: OPT_FIELDS, limit: 100, offset } },
        );
        const rows = Array.isArray(result.data) ? result.data : [];
        collected.push(...rows);
        if (!result.nextOffset) {
          hitCap = false;
          break;
        }
        offset = result.nextOffset;
        hitCap = true;
      }

      if (collected.length === 0) {
        return toToolResult(
          `Asana: no attachments on task ${params.task_gid}. (Files uploaded to the task AND images pasted into comments both appear here; if the task truly has none, there is nothing to download.)`,
        );
      }

      const lines: string[] = [];
      lines.push(
        `Asana: ${collected.length} attachment${collected.length === 1 ? "" : "s"} on task ${params.task_gid}.`,
      );
      lines.push("");
      for (const a of collected) {
        const host = a.host ?? "?";
        const canDownload = Boolean(a.download_url);
        const owner = a.created_by?.name ?? "unknown";
        const when = a.created_at ?? "(no timestamp)";
        const reach = canDownload
          ? "asana-hosted (downloadable)"
          : `external host (${host}) - returns a view_url, not a local file`;
        lines.push(
          `- ${a.name ?? "(unnamed)"} (gid: ${a.gid}) - ${humanSize(a.size)}, by ${owner} at ${when}`,
        );
        lines.push(`    host: ${host}; ${reach}`);
        lines.push(
          `    call asana_download_attachment with attachment_gid=${a.gid} to fetch it.`,
        );
      }
      if (hitCap) {
        lines.push(
          "(Hit the local pagination cap; the task may have >1000 attachments. Rare.)",
        );
      }
      return toToolResult(lines.join("\n").trimEnd());
    } catch (err) {
      if (err instanceof AsanaError && err.status === 404) {
        return toToolResult(
          `Asana: task ${params.task_gid} not found. Verify the GID with \`asana_search_objects\` (resource_type=task).`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};
