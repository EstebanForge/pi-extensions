import { Type, type Static } from "typebox";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { slackGet, slackDownload } from "../api";
import { toToolResult, errorText, type SlackDetails } from "../result";
import { formatDownloadedFile } from "../format";
import type { SlackFileInfo } from "../types";
import {
  DOWNLOAD_FILE_TITLE,
  DOWNLOAD_FILE_DESCRIPTION,
  DOWNLOAD_FILE_ID_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  file_id: Type.String({ description: DOWNLOAD_FILE_ID_DESCRIPTION }),
});

// Slack returns snake_case keys; SlackFileInfo in types.ts now mirrors them.
interface FileInfoResponse {
  ok: boolean;
  file?: SlackFileInfo;
}

const TMP_DIR = join(tmpdir(), "pi-slack-me");

// Download a shared file to a temp dir and return the local path. Slack stores
// files at url_private / url_private_download, both requiring the bearer token.
// We preserve the original extension so the `read` tool picks the right viewer.
export const downloadFileTool: ToolDefinition<typeof Params, SlackDetails> = {
  name: "slack_download_file",
  label: DOWNLOAD_FILE_TITLE,
  description: DOWNLOAD_FILE_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<SlackDetails>> {
    try {
      const infoResp = await slackGet<FileInfoResponse>("files.info", {
        query: { file: params.file_id },
      });
      const file = infoResp.file;
      if (!file) {
        return toToolResult(`Slack: no file found with id ${params.file_id}.`);
      }

      const downloadUrl = file.url_private_download ?? file.url_private;
      if (!downloadUrl) {
        return toToolResult(
          `Slack: file ${params.file_id} has no downloadable URL (it may have been removed or is stored externally).`,
        );
      }

      const buf = await slackDownload(downloadUrl);
      await mkdir(TMP_DIR, { recursive: true });
      const ext = file.filetype ? `.${file.filetype}` : "";
      const base = file.name?.replace(/\.[^.]+$/, "") ?? params.file_id;
      const localPath = join(TMP_DIR, `${base}-${randomBytes(4).toString("hex")}${ext}`);
      await writeFile(localPath, Buffer.from(buf));

      return toToolResult(formatDownloadedFile(file, localPath));
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
