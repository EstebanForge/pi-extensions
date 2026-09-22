// Attachment upload for the git-me comment tools (git_pr_comment,
// git_issue_comment, git_discussion_comment). GitHub has no GraphQL/REST
// "attach a file to a comment" field; the upload target is the user-asset
// endpoint the gh CLI itself uses for `--attach` (v2.99+):
//
//   POST https://uploads.github.com/user-attachments/assets
//        ?name=<basename>&content_type=<mime>&repository_id=<rest id>
//   Authorization: Bearer $(gh auth token)
//   body: raw file bytes
//   -> 201 {"url": "https://github.com/user-attachments/assets/<id>"}
//
// The returned URL is a normal image/video URL that renders inline from any
// Markdown comment body, so the tools append `![name](url)` to the body they
// already post. Going one level below the `--attach` flag is deliberate: the
// flag exists only on `gh issue comment` / `gh pr comment`, while discussion
// comments are GraphQL-only, and this endpoint covers all three surfaces with
// one implementation. Constraints verified against live GitHub (2026-08, and
// encoded in gh's internal/attachments client): images and video only, and
// the token needs WRITE access to the repository the id is sent for - read-
// only tokens get a 404.

import { readFile, stat } from "node:fs";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import { runGh } from "./auth";
import { ghRepoView } from "./github";

const statAsync = promisify(stat);
const readFileAsync = promisify(readFile);

// Same media list gh's --attach accepts (docs: "Attaching files with GitHub
// CLI"). Everything else (pdf, zip, text) is rejected by the endpoint with a
// 422, so refusing locally turns a confusing 422 into a stated fact.
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

const SUPPORTED_LIST = Object.keys(MIME_BY_EXT).join(", ");

const UPLOAD_BASE = "https://uploads.github.com/user-attachments/assets";
// Videos are the realistic heavy case; gh's own uploader allows 120s for the
// same leg. JSON API calls stay on auth.ts's spawnSync timeouts.
const UPLOAD_TIMEOUT_MS = 120_000;

/** MIME type for a supported attachment path, or null when unsupported. */
export function detectAttachmentMime(path: string): string | null {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? null;
}

/** Validate every path up front so a doomed comment never reaches review. */
export async function validateAttachmentPaths(paths: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const path of paths) {
    const mime = detectAttachmentMime(path);
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

/** The token gh is authenticated with (env GH_TOKEN/GITHUB_TOKEN first, then the keyring). */
export function ghAuthToken(cwd: string): string {
  const result = runGh(["auth", "token"], cwd);
  const token = result.stdout.trim();
  if (result.exitCode !== 0 || !token) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `git-me: could not get an auth token from \`gh auth token\` for the attachment upload. ${detail || "Run `gh auth login` first."}`,
    );
  }
  return token;
}

/** Numeric REST id of the repository, required by the upload endpoint. */
export function ghRepoNumericId(nameWithOwner: string, cwd: string): string {
  const result = runGh(["api", `repos/${nameWithOwner}`, "--jq", ".id"], cwd);
  const id = result.stdout.trim();
  if (result.exitCode !== 0 || !id) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `git-me: could not resolve the repository id for ${nameWithOwner} (\`gh api repos/${nameWithOwner}\`). ${detail}`,
    );
  }
  return id;
}

export interface UploadedAttachment {
  url: string;
  filename: string;
}

/**
 * Upload one file and return its permanent user-attachments URL. Nothing is
 * posted anywhere yet - the caller appends the returned markdown to the body
 * it posts. Non-2xx responses map to the two known causes (no write access ->
 * 404, media type not allowed -> 422) plus the raw status so unknown failures
 * stay diagnosable.
 */
export async function uploadGitHubAttachment(args: {
  path: string;
  repoId: string;
  token: string;
}): Promise<UploadedAttachment> {
  const filename = basename(args.path);
  const bytes = await readFileAsync(args.path);
  const contentType = MIME_BY_EXT[extname(args.path).toLowerCase()];

  // URLSearchParams, not string concat: image/svg+xml carries a '+' that a
  // raw query string turns into a space, and GitHub then 422s with a
  // misleading extension-mismatch error.
  const url = `${UPLOAD_BASE}?${new URLSearchParams({
    name: filename,
    content_type: contentType,
    repository_id: args.repoId,
  }).toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(bytes),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) {
      throw new Error(
        `git-me: attachment upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s (${filename}). Nothing was posted.`,
      );
    }
    throw new Error(`git-me: network error uploading ${filename}: ${msg}. Nothing was posted.`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 200);
    let hint = "";
    if (response.status === 404) {
      hint = " The upload endpoint reports 404 when the token lacks WRITE access to the repository (read-only tokens cannot attach files).";
    } else if (response.status === 422) {
      hint = ` GitHub only accepts these types on this endpoint: ${SUPPORTED_LIST}.`;
    } else if (response.status === 401 || response.status === 403) {
      hint = " The token from `gh auth token` was rejected; re-authenticate with `gh auth login`.";
    }
    throw new Error(
      `git-me: attachment upload failed (HTTP ${response.status}) for ${filename}.${hint}${body ? ` ${body}` : ""} Comment NOT posted.`,
    );
  }

  let asset: { url?: string };
  try {
    asset = (await response.json()) as { url?: string };
  } catch {
    throw new Error(
      `git-me: attachment upload for ${filename} returned non-JSON output. Comment NOT posted.`,
    );
  }
  if (!asset.url) {
    throw new Error(
      `git-me: attachment upload for ${filename} returned no asset URL. Comment NOT posted.`,
    );
  }
  return { url: asset.url, filename };
}

/**
 * Sanitized filename for markdown alt text. A raw basename containing ], [,
 * or a newline would terminate/derail the ![alt](url) construct and inject
 * stray literal text (or worse) into a posted, public comment. The URL half
 * is GitHub-generated (user-attachments/assets/<id>) and needs no escaping.
 */
function markdownAlt(filename: string): string {
  return filename.replace(/[[\]\r\n]/g, " ");
}

/**
 * Append `![name](url)` markdown for every uploaded attachment to the end of
 * the comment body, in upload order - the same placement gh's --attach uses
 * for files the body does not already reference.
 */
export function appendAttachments(body: string, uploaded: UploadedAttachment[]): string {
  if (uploaded.length === 0) return body;
  const markdown = uploaded.map((a) => `![${markdownAlt(a.filename)}](${a.url})`).join("\n");
  return `${body}\n\n${markdown}`;
}

/**
 * Full pre-post upload pass for a comment tool: resolve the repository id and
 * token once, upload every file in order, return the uploads. Throws on the
 * first failure; the caller must NOT post the comment in that case (the error
 * messages already say so), because a body referencing a half-uploaded set
 * would ship a broken image.
 *
 * Note: the repository id resolves from the LOCAL CHECKOUT's remote. In a
 * fork workflow (origin = your fork, PR lives upstream) the id authorizing
 * the upload may not be the PR's repository; user-attachments render
 * regardless of which accessible repo authorized them, but a permission
 * mismatch would surface here as the endpoint's 404.
 */
export async function uploadAttachmentsForComment(args: {
  paths: string[];
  nameWithOwner: string;
  cwd: string;
}): Promise<UploadedAttachment[]> {
  const repoId = ghRepoNumericId(args.nameWithOwner, args.cwd);
  const token = ghAuthToken(args.cwd);
  const uploaded: UploadedAttachment[] = [];
  for (const path of args.paths) {
    try {
      uploaded.push(await uploadGitHubAttachment({ path, repoId, token }));
    } catch (err) {
      // Unlike Slack (auto-discards), GitHub keeps user-attachments forever.
      // Files that uploaded before the failure are real, live URLs - honest
      // failure reporting names them so the agent can reference or ignore.
      if (uploaded.length > 0) {
        const landed = uploaded.map((u) => `${u.filename} (${u.url})`).join(", ");
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${detail} Already uploaded (kept, unreferenced): ${landed}.`,
        );
      }
      throw err;
    }
  }
  return uploaded;
}

/**
 * Resolve the repo for a comment tool that was not handed one (pr/issue
 * comment paths). Returns null-compatible error text via ghRepoView's own
 * contract; the caller turns null into its actionable message.
 */
export function repoForAttachmentUpload(cwd: string) {
  return ghRepoView(cwd);
}
