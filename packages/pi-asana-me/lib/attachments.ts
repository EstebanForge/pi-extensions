// Image attachments for asana_add_comment. Asana's API has no comment-level
// file upload; attachments bind to the TASK (POST /attachments with parent),
// and the documented rich-text layer is what puts them ON the comment:
// a story whose html_text embeds `<img data-asana-gid="GID"/>` renders the
// image inline. Two constraints drive the code:
//
//   - The attachment MUST keep the default resource_subtype ("asana"): an
//     "external"-subtype attachment is rejected as an inline image with
//     "Not a valid image asset id". So the upload omits resource_subtype and
//     passes the bytes as a file, never a url.
//   - Asana does NOT reject malformed html_text; it silently stores the whole
//     comment as literal text (HTTP 201, no error). The plain-text path
//     therefore XML-escapes the comment text, and the html path reuses
//     comment-add's validateHtmlText BEFORE the <img> tags are inserted.

import { readFile, stat } from "node:fs";
import { basename, extname } from "node:path";
import { promisify } from "node:util";

const statAsync = promisify(stat);
const readFileAsync = promisify(readFile);

// Images only: this list is what Asana renders inline in a story. Other
// binaries would attach but show as a bare file entry, which reads as a bug.
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

/** Validate every image path up front so a doomed comment never reaches review. */
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

/** Read an image's bytes for upload. Caller has validated the path already. */
export async function readImage(path: string): Promise<{
  filename: string;
  bytes: Buffer;
  contentType: string;
}> {
  return {
    filename: basename(path),
    bytes: await readFileAsync(path),
    contentType: IMAGE_MIME_BY_EXT[extname(path).toLowerCase()],
  };
}

// XML escape for text nodes AND attribute values. Asana html_text is strict
// XML; a bare "<" in a comment body would break the whole document.
function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function imgTag(gid: string, filename: string): string {
  return `<img data-asana-gid="${gid}" alt="${escapeXml(filename)}"/>`;
}

/**
 * Build the story html_text that carries the comment text plus the inline
 * images. Two modes:
 *   - plain text (html=false): escape the text and wrap it ourselves, with
 *     one <img> per attachment on its own line.
 *   - html_text (html=true): the caller has already validated the user's
 *     markup; splice the <img> tags in before the closing </body>.
 */
export function buildStoryHtml(args: {
  text: string;
  html: boolean;
  images: Array<{ gid: string; filename: string }>;
}): string {
  const tags = args.images.map((img) => imgTag(img.gid, img.filename));
  if (args.html) {
    const insertAt = args.text.replace(/\s*<\/body>\s*$/i, "").length;
    const insertion = tags.length > 0 ? `\n${tags.join("\n")}` : "";
    return `${args.text.slice(0, insertAt)}${insertion}${args.text.slice(insertAt)}`;
  }
  const imageBlock = tags.length > 0 ? `\n${tags.join("\n")}` : "";
  return `<body>${escapeXml(args.text)}${imageBlock}</body>`;
}
