import { Type, type Static } from "typebox";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, downloadExternalUrl, AsanaError } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaAttachment } from "../types";
import { getScratchDir } from "../scratch-dir";
import {
  ATTACHMENT_DOWNLOAD_TITLE,
  ATTACHMENT_DOWNLOAD_DESCRIPTION,
  ATTACHMENT_DOWNLOAD_GID_DESCRIPTION,
  ATTACHMENT_DOWNLOAD_OUTPUT_DIR_DESCRIPTION,
  ATTACHMENT_DOWNLOAD_FILENAME_DESCRIPTION,
} from "../prompts";

// Download one attachment's bytes to a local file. The whole reason this tool
// exists: an agent reading a task that says "see the attached XLS" or "image
// pasted in the comment below" has nowhere to go without it - it cannot fetch
// binary through the JSON-only tools, and Asana's `download_url` is an S3
// presigned link that must be fetched WITHOUT the Bearer token and expires in
// ~2 min. This tool owns both quirks.
//
// Flow:
//   1. GET /attachments/{gid} -> metadata (name, host, download_url, view_url)
//   2. host=asana + download_url present:
//        downloadExternalUrl(download_url)  // no auth header
//        -> write bytes under sanitized filename -> return absolute path
//   3. external host (download_url null/empty):
//        cannot auto-download (gdrive/dropbox/box/onedrive need a browser
//        session the agent does not have) -> return view_url for agent_browser
//
// The returned local path is what makes images usable: the agent runs the
// `read` tool on it to actually see an image, or parses a csv/xls/json from
// disk. This mirrors how jira_download_attachments hands back a path rather
// than inlining bytes into the tool result.

// Only the fields the tool renders / branches on. Keeping the projection
// tight avoids paying for metadata the tool never reads (finding: opt_fields
// had listed resource_subtype/size/created_at/created_by/parent, all unused).
const OPT_FIELDS = ["name", "host", "download_url", "view_url"].join(",");

const Params = Type.Object({
  attachment_gid: Type.String({ description: ATTACHMENT_DOWNLOAD_GID_DESCRIPTION }),
  output_dir: Type.Optional(
    Type.String({ description: ATTACHMENT_DOWNLOAD_OUTPUT_DIR_DESCRIPTION }),
  ),
  filename: Type.Optional(
    Type.String({ description: ATTACHMENT_DOWNLOAD_FILENAME_DESCRIPTION }),
  ),
});

// Reduce an Asana-controlled (or caller-supplied) name to a safe basename so
// it cannot escape outputDir and cannot crash or hijack the write:
//   - split on both / and \ and take the last segment (kills "../" and
//     drive-relative joins)
//   - strip a leading drive letter ("C:foo") that survives the split
//   - strip leading dots (".." -> "")
//   - drop NUL + shell/device chars that are illegal or dangerous on disk
//   - cap length so we never hit ENAMETOOLONG
//   - rename Windows reserved device names (CON/PRN/AUX/NUL/COMn/LPTn)
// Fall back to the gid when nothing usable is left. Unicode survives.
const RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
export function safeFilename(name: string | undefined, fallback: string): string {
  const raw = typeof name === "string" && name.length > 0 ? name : fallback;
  const lastSegment = raw.split(/[\\/]+/).pop() ?? raw;
  let cleaned = lastSegment
    .replace(/^[a-zA-Z]:/, "") // drive letter ("C:foo")
    .replace(/^\.+/, "") // leading dots ("..", "....")
    .replace(/[\u0000<>:"|?*]/g, "_") // NUL + illegal shell/device chars
    .slice(0, 200);
  if (RESERVED_RE.test(cleaned)) cleaned = `${cleaned}_`;
  return cleaned.length > 0 ? cleaned : fallback;
}

export const downloadAttachmentTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_download_attachment",
  label: ATTACHMENT_DOWNLOAD_TITLE,
  description: ATTACHMENT_DOWNLOAD_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    // Metadata fetch: scoped try/catch so a 404 HERE is reported as a bad
    // attachment GID. The S3 download below has its own error path (a 403/404
    // from an expired presigned link must surface as a RETRY, not "not
    // found" - otherwise the agent re-lists, gets the same GID, and loops).
    let meta: AsanaAttachment;
    try {
      meta = await callAsana<AsanaAttachment>(
        "GET",
        `/attachments/${encodeURIComponent(params.attachment_gid)}`,
        { query: { opt_fields: OPT_FIELDS } },
      );
    } catch (err) {
      if (err instanceof AsanaError && err.status === 404) {
        return toToolResult(
          `Asana: attachment ${params.attachment_gid} not found. Get a valid attachment_gid from asana_list_attachments.`,
        );
      }
      return toToolResult(errorText(err));
    }

    const host = meta.host ?? "?";
    const viewUrl = meta.view_url ?? "(no view_url)";
    const downloadUrl = meta.download_url ?? null;

    // No auto-downloadable URL. Two sub-cases:
    //   - host=asana but download_url is missing -> the link was unavailable /
    //     not yet generated; tell the agent to retry, not to treat it as
    //     external.
    //   - any other host -> genuinely external (gdrive/dropbox/box/onedrive);
    //     hand back the view_url for a browser.
    if (!downloadUrl) {
      const asanaButMissing = host === "asana";
      const headline = asanaButMissing
        ? `Asana: attachment ${params.attachment_gid} (${meta.name ?? "(unnamed)"}) is Asana-hosted but had no download_url. Retry asana_download_attachment to refresh the link.`
        : `Asana: attachment ${params.attachment_gid} (${meta.name ?? "(unnamed)"}) is hosted externally (${host}) and cannot be auto-downloaded.`;
      const lines = [
        headline,
        ...(asanaButMissing ? [] : [`view_url: ${viewUrl}`, `Open the link in a browser (agent_browser) or hand it to the user.`]),
      ];
      return toToolResult(lines.join("\n"));
    }

    // Asana-hosted: fetch the S3 presigned link WITHOUT the Bearer token
    // (downloadExternalUrl sends no auth header on purpose; S3 rejects it).
    // This whole fetch+write is in its own try/catch so an S3 403/404 (expired
    // presigned link) surfaces as the retry hint from downloadExternalUrl,
    // NOT as a 404 "attachment not found" (the metadata call already owns
    // that mapping above).
    try {
      const { bytes, contentType } = await downloadExternalUrl(downloadUrl);

      // Resolve the output directory. Default: a per-process scratch dir
      // under os.tmpdir() that is wiped on process exit (lib/scratch-dir.ts),
      // so files never accumulate across sessions and the agent never needs a
      // cleanup routine. An explicit output_dir override is caller-owned and
      // NOT auto-cleaned.
      const baseDir =
        params.output_dir && params.output_dir.length > 0
          ? path.resolve(params.output_dir)
          : await getScratchDir();
      await fs.mkdir(baseDir, { recursive: true });

      const fname = safeFilename(params.filename ?? meta.name, params.attachment_gid);
      const outPath = path.join(baseDir, fname);
      await fs.writeFile(outPath, Buffer.from(bytes));

      const lines = [
        `Asana: downloaded attachment ${params.attachment_gid} (${meta.name ?? "(unnamed)"}) to:`,
        outPath,
        `host: ${host}; size: ${bytes.byteLength} bytes; content-type: ${contentType}`,
        `Next: run the \`read\` tool on the path above to view an image, or parse it for csv/xls/json.`,
      ];
      return toToolResult(lines.join("\n"));
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
