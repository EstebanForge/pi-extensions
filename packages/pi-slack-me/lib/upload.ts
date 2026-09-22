// Image attachment for slack_post_message. Implements the modern Slack file
// upload flow (what files.uploadV2 wraps), because chat.postMessage cannot
// carry files:
//
//   1. files.getUploadURLExternal  -> { upload_url, file_id } (form-encoded)
//   2. POST file bytes to upload_url                            (raw, presigned)
//   3. files.completeUploadExternal  -> posts the file-share message
//
// Step 3 IS the message post: channel_id + initial_comment + thread_ts ride on
// completeUploadExternal, so the tool skips chat.postMessage entirely when
// images are attached. If any step fails before completion, no message exists
// and Slack discards the un-completed upload on its own (documented behavior:
// "If files.completeUploadExternal is not called, the upload will be aborted"),
// so a mid-way failure leaves no orphan file and no half-sent message.
//
// Scope: every step needs files:write on the user token; the README setup
// table lists it and missing_scope errors map to it via api.ts.

import { readFile, stat } from "node:fs";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import { slackPost, slackUploadBytes, SlackApiError } from "./api";
const statAsync = promisify(stat);
const readFileAsync = promisify(readFile);

// Images only: the request is screenshots/photos, and this list is exactly
// what Slack renders inline. A .pdf or .zip would upload but not preview,
// which reads as a bug; refusing with the supported list reads as a fact.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

const SUPPORTED_LIST = Object.keys(IMAGE_MIME_BY_EXT).join(", ");

/** MIME type for a supported image path, or null when unsupported. */
export function detectImageMime(path: string): string | null {
  return IMAGE_MIME_BY_EXT[extname(path).toLowerCase()] ?? null;
}

/** Validate every image path up front so a doomed send never reaches review. */
export async function validateImagePaths(paths: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const path of paths) {
    const mime = detectImageMime(path);
    if (!mime) {
      problems.push(`${path}: unsupported type. Supported: ${SUPPORTED_LIST}.`);
      continue;
    }
    try {
      const info = await statAsync(path);
      if (!info.isFile()) problems.push(`${path}: not a regular file.`);
    } catch {
      problems.push(`${path}: file not found.`);
    }
  }
  return problems;
}

interface UploadUrlResponse {
  ok: boolean;
  upload_url?: string;
  file_id?: string;
}

interface CompleteResponse {
  ok: boolean;
  files?: Array<{
    id?: string;
    shares?: {
      public?: Record<string, Array<{ ts?: string }>>;
      private?: Record<string, Array<{ ts?: string }>>;
    };
  }>;
}

// The ts of the file-share message is not a documented completeUploadExternal
// field, so fish it out defensively: when present it lives under
// files[0].shares.<visibility>[channel][0].ts. Absent -> undefined and the
// tool just omits the ts from its success line.
function extractTs(
  resp: CompleteResponse,
  channel: string,
): string | undefined {
  const shares = resp.files?.[0]?.shares;
  return (
    shares?.public?.[channel]?.[0]?.ts ??
    shares?.private?.[channel]?.[0]?.ts ??
    undefined
  );
}

/**
 * Upload every image and post ONE file-share message carrying all of them.
 * Returns the message ts when Slack surfaces it (it usually does not - the
 * documented response is just {ok, files}).
 */
export async function slackUploadAndShare(args: {
  channel: string;
  text: string;
  threadTs?: string;
  imagePaths: string[];
}): Promise<{ ts?: string; fileIds: string[] }> {
  // Steps 1+2 for every image first: if any upload fails we bail before step 3
  // and Slack discards the whole batch (no partial attachment set).
  const uploaded: Array<{ id: string; title: string }> = [];
  for (const path of args.imagePaths) {
    const title = basename(path);
    const bytes = await readFileAsync(path);
    // Form-encoded on purpose: the docs list application/json for this
    // method, but live Slack rejects a JSON body with invalid_arguments
    // (probed 2026-09-05); urlencoded works.
    const urlResp = await slackPost<UploadUrlResponse>(
      "files.getUploadURLExternal",
      { form: { filename: title, length: String(bytes.byteLength) } },
    );
    if (!urlResp.upload_url || !urlResp.file_id) {
      throw new SlackApiError(
        `Slack: files.getUploadURLExternal returned no upload URL for ${title}. Nothing was sent.`,
      );
    }
    await slackUploadBytes(
      urlResp.upload_url,
      bytes,
      IMAGE_MIME_BY_EXT[extname(path).toLowerCase()],
    );
    uploaded.push({ id: urlResp.file_id, title });
  }

  // Step 3 completes the batch and posts the message in one call. The files
  // array travels as a JSON string inside the form body (Slack's standard way
  // to take arrays over urlencoded).
  const form: Record<string, string> = {
    files: JSON.stringify(uploaded),
    channel_id: args.channel,
    initial_comment: args.text,
  };
  if (args.threadTs) form.thread_ts = args.threadTs;
  const complete = await slackPost<CompleteResponse>(
    "files.completeUploadExternal",
    { form },
  );
  return {
    ts: extractTs(complete, args.channel),
    fileIds: uploaded.map((f) => f.id),
  };
}
