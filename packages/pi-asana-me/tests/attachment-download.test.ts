import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke, firstText } from "./_helpers";
import { promises as realFs } from "node:fs";
import path from "node:path";
import os from "node:os";

beforeEach(() => {
  process.env.ASANA_ACCESS_TOKEN = "test-token";
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.ASANA_ACCESS_TOKEN;
  // Reset the process scratch dir so the default-path test below does not
  // leave a dir + exit listener bound for the rest of the suite.
  const { _resetScratch } = await import("../lib/scratch-dir");
  _resetScratch();
});

function makeResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body as unknown,
  } as unknown as Response;
}

// Binary S3 response: must expose arrayBuffer() + a real Headers object so
// the tool can read content-type. The Asana-API JSON makeResponse above has
// neither.
function makeBinaryResponse(text: string, contentType = "application/octet-stream") {
  const ab = new TextEncoder().encode(text).buffer as ArrayBuffer;
  const headers = new Headers();
  headers.set("content-type", contentType);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => ab,
    text: async () => text,
    json: async () => ({}),
    headers,
  } as unknown as Response;
}

interface SeenCall {
  url: string;
  headers: Record<string, string>;
}

const S3_URL = "https://s3.asana-host.example/presigned-link";

// Route fetch by URL: Asana API metadata call -> JSON; S3 download_url ->
// binary. Record every call's headers so the no-bearer-token assertion can
// inspect the S3 request specifically.
async function callDownload(
  params: Record<string, unknown>,
  attachmentShape: Record<string, unknown> = {},
) {
  const seen: SeenCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    seen.push({
      url: u,
      headers: ((init?.headers as Record<string, string>) ?? {}),
    });
    if (u.includes("/api/1.0/attachments/")) {
      return makeResponse({
        data: {
          gid: params.attachment_gid,
          name: "roster.csv",
          host: "asana",
          download_url: S3_URL,
          view_url: "https://app.asana.com/0/0/att",
          size: 5,
          ...attachmentShape,
        },
      });
    }
    if (u === S3_URL) {
      return makeBinaryResponse("hello", "text/csv");
    }
    return makeResponse({ data: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { downloadAttachmentTool } = await import("../lib/tools/attachment-download");
  return {
    text: firstText(await invoke(downloadAttachmentTool, params)),
    fetchMock,
    seen,
  };
}

describe("asana_download_attachment", () => {
  it("fetches metadata from /attachments/{gid} then downloads the S3 link WITHOUT the Bearer token", async () => {
    const tmp = await realFs.mkdtemp(path.join(os.tmpdir(), "asana-dl-"));
    try {
      const { text, seen } = await callDownload({
        attachment_gid: "a1",
        output_dir: tmp,
      });
      // Two fetches: Asana metadata + S3 binary.
      expect(seen).toHaveLength(2);
      // Call 1: Asana API metadata call carries the Bearer token.
      expect(seen[0].url).toContain("/api/1.0/attachments/a1");
      expect(seen[0].headers.Authorization).toBe("Bearer test-token");
      // Call 2: S3 presigned download_url carries NO Authorization header
      // (S3 rejects it). This is the core invariant of the download path.
      expect(seen[1].url).toBe(S3_URL);
      expect(seen[1].headers.Authorization).toBeUndefined();

      // The result names the on-disk path so the agent can `read` it.
      expect(text).toContain("downloaded attachment a1");
      expect(text).toContain(tmp);

      // And the file actually landed with the attachment's own name + bytes.
      const written = await realFs.readFile(path.join(tmp, "roster.csv"), "utf8");
      expect(written).toBe("hello");
    } finally {
      await realFs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns the view_url and writes NO file for an external-host attachment", async () => {
    const tmp = await realFs.mkdtemp(path.join(os.tmpdir(), "asana-dl-"));
    try {
      // Override shape: external host, null download_url.
      const { text, seen } = await callDownload(
        { attachment_gid: "g1", output_dir: tmp },
        { host: "gdrive", download_url: null, name: "plan.gsheet", view_url: "https://drive/plan" },
      );
      // Only the metadata call happened; no S3 download attempted.
      expect(seen).toHaveLength(1);
      expect(text).toContain("hosted externally (gdrive)");
      expect(text).toContain("cannot be auto-downloaded");
      expect(text).toContain("https://drive/plan");
      // Directory stayed empty.
      const entries = await realFs.readdir(tmp);
      expect(entries).toEqual([]);
    } finally {
      await realFs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("sanitizes a caller-supplied filename, stripping path traversal", async () => {
    const tmp = await realFs.mkdtemp(path.join(os.tmpdir(), "asana-dl-"));
    try {
      const { text } = await callDownload({
        attachment_gid: "a9",
        output_dir: tmp,
        filename: "../../../../etc/evil.csv",
      });
      // Must land inside tmp as basename-only; the path-traversal attempt
      // is neutralized. Reading the sanitized path back proves it.
      const insidePath = path.join(tmp, "evil.csv");
      const written = await realFs.readFile(insidePath, "utf8");
      expect(written).toBe("hello");
      expect(text).toContain(insidePath);
      // Exactly one file, inside the dir - nothing wrote up the tree.
      const entries = await realFs.readdir(tmp);
      expect(entries).toEqual(["evil.csv"]);
      // The advertised path resolves to a location still inside tmp.
      const advertised = text
        .split("\n")
        .find((l) => l.includes("evil.csv"))
        ?.trim();
      expect(advertised && path.resolve(advertised).startsWith(tmp)).toBe(true);
    } finally {
      await realFs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("neutralizes a hostile ATTACHMENT NAME (not just a caller filename)", async () => {
    // The real threat is Asana-controlled meta.name, which flows into
    // safeFilename at the same call site as the caller param. The earlier
    // test only exercised the caller filename; this one drives the actually
    // untrusted input with no filename override.
    const tmp = await realFs.mkdtemp(path.join(os.tmpdir(), "asana-dl-"));
    try {
      const { text } = await callDownload(
        { attachment_gid: "a10", output_dir: tmp },
        { name: "../../../../etc/evil.csv" },
      );
      const insidePath = path.join(tmp, "evil.csv");
      expect(await realFs.readFile(insidePath, "utf8")).toBe("hello");
      // Exactly one file lands inside tmp; nothing escaped up the tree.
      expect(await realFs.readdir(tmp)).toEqual(["evil.csv"]);
      // Boundary check (not a prefix check): the resolved advertised path must
      // stay within tmp.
      const advertised = text
        .split("\n")
        .find((l) => l.trim().startsWith(os.tmpdir()))
        ?.trim();
      const rel = path.relative(tmp, advertised!);
      expect(rel.startsWith("..")).toBe(false);
    } finally {
      await realFs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("writes to a per-process temp dir under os.tmpdir() when output_dir is omitted", async () => {
    // No output_dir: the tool must use the auto-cleaning scratch dir, not a
    // stable app dir that would accumulate files across sessions.
    const { text } = await callDownload({ attachment_gid: "a7" });
    expect(text).toContain("downloaded attachment a7");
    // The path is the line that starts with the OS temp folder (the
    // "(roster.csv) to:" summary line also mentions the name but is not a
    // path, so filter for the real prefix).
    const advertised = text
      .split("\n")
      .find((l) => l.trim().startsWith(os.tmpdir()))
      ?.trim();
    expect(advertised).toBeTruthy();
    expect(path.basename(path.dirname(advertised!)).startsWith("pi-asana-me-")).toBe(true);
    expect(path.basename(advertised!)).toBe("roster.csv");
    // File is readable where promised.
    expect(await realFs.readFile(advertised!, "utf8")).toBe("hello");
  });

  it("falls back to the attachment gid when Asana omits the name", async () => {
    const tmp = await realFs.mkdtemp(path.join(os.tmpdir(), "asana-dl-"));
    try {
      const { text } = await callDownload(
        { attachment_gid: "777", output_dir: tmp },
        { name: undefined },
      );
      const written = await realFs.readFile(path.join(tmp, "777"), "utf8");
      expect(written).toBe("hello");
      expect(text).toContain(path.join(tmp, "777"));
    } finally {
      await realFs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("points back to asana_list_attachments on 404 metadata", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ errors: [{ message: "not_found" }] }),
        json: async () => ({ errors: [{ message: "not_found" }] }),
      } as unknown as Response),
    );
    const { downloadAttachmentTool } = await import("../lib/tools/attachment-download");
    const text = firstText(await invoke(downloadAttachmentTool, { attachment_gid: "ghost" }));
    expect(text).toContain("attachment ghost not found");
    expect(text).toContain("asana_list_attachments");
  });

  it("reports an expired download_url as a retryable download failure", async () => {
    const tmp = await realFs.mkdtemp(path.join(os.tmpdir(), "asana-dl-"));
    try {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/api/1.0/attachments/")) {
          return makeResponse({
            data: { gid: "a1", name: "x.csv", host: "asana", download_url: S3_URL, view_url: "v" },
          });
        }
        if (u === S3_URL) {
          return {
            ok: false,
            status: 403,
            text: async () => "forbidden",
            headers: new Headers(),
          } as unknown as Response;
        }
        return makeResponse({});
      });
      vi.stubGlobal("fetch", fetchMock);
      const { downloadAttachmentTool } = await import("../lib/tools/attachment-download");
      const text = firstText(
        await invoke(downloadAttachmentTool, { attachment_gid: "a1", output_dir: tmp }),
      );
      expect(text).toContain("HTTP 403");
      expect(text).toMatch(/download_url may have expired|retry/i);
      // Critical: an S3 403/404 (expired presigned link) must NOT read
      // "attachment not found". That message is reserved for a 404 on the
      // metadata call; conflating them sends the agent into a re-list loop
      // (same GID, same expired link).
      expect(text).not.toContain("not found");
      expect(text).not.toContain("asana_list_attachments");
      // Nothing written on failure.
      expect(await realFs.readdir(tmp)).toEqual([]);
    } finally {
      await realFs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("treats an Asana-hosted attachment with no download_url as a retry, not external", async () => {
    const tmp = await realFs.mkdtemp(path.join(os.tmpdir(), "asana-dl-"));
    try {
      const { text, seen } = await callDownload(
        { attachment_gid: "a8", output_dir: tmp },
        { host: "asana", download_url: null, name: "weird.xlsx", view_url: "https://view/a8" },
      );
      // Only the metadata call; no S3 fetch attempted.
      expect(seen).toHaveLength(1);
      // The message must say the link was unavailable + retry, NOT "externally
      // hosted (asana)" which is contradictory.
      expect(text).toContain("Asana-hosted but had no download_url");
      expect(text).toMatch(/retry asana_download_attachment/i);
      expect(text).not.toContain("externally");
      // No file written.
      expect(await realFs.readdir(tmp)).toEqual([]);
    } finally {
      await realFs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// Direct unit tests for the filename sanitizer. These cover the hostile / edge
// inputs the end-to-end download tests do not (NUL bytes, Windows reserved
// device names, drive prefixes, length caps) so a regression here is caught
// without standing up the whole fetch + write path.
describe("safeFilename", () => {
  it("strips path traversal on both separators and keeps the basename", async () => {
    const { safeFilename } = await import("../lib/tools/attachment-download");
    expect(safeFilename("../../../../etc/evil.csv", "fallback")).toBe("evil.csv");
    expect(safeFilename("a\\b\\c.csv", "fallback")).toBe("c.csv");
  });

  it("reduces pure dot-segments to the fallback", async () => {
    const { safeFilename } = await import("../lib/tools/attachment-download");
    expect(safeFilename("..", "fallback")).toBe("fallback");
    expect(safeFilename(".", "fallback")).toBe("fallback");
    expect(safeFilename("....", "fallback")).toBe("fallback");
    expect(safeFilename("", "fallback")).toBe("fallback");
    expect(safeFilename(undefined, "fallback")).toBe("fallback");
  });

  it("strips a leading drive letter so no drive-relative join survives", async () => {
    const { safeFilename } = await import("../lib/tools/attachment-download");
    expect(safeFilename("C:evil.csv", "fallback")).toBe("evil.csv");
    // A bare drive-only name still falls through to the fallback.
    expect(safeFilename("D:", "fallback")).toBe("fallback");
  });

  it("neutralizes NUL and shell/device chars instead of crashing", async () => {
    const { safeFilename } = await import("../lib/tools/attachment-download");
    // A NUL byte would make fs.writeFile throw ERR_INVALID_ARG_VALUE; here it
    // becomes an underscore.
    expect(safeFilename("ev\u0000il.csv", "fallback")).toBe("ev_il.csv");
    expect(safeFilename('a"b:c*d', "fallback")).toBe("a_b_c_d");
  });

  it("caps the length to avoid ENAMETOOLONG", async () => {
    const { safeFilename } = await import("../lib/tools/attachment-download");
    const long = "x".repeat(500);
    expect(safeFilename(long, "fallback").length).toBe(200);
  });

  it("renames Windows reserved device names so they write to a file, not a device", async () => {
    const { safeFilename } = await import("../lib/tools/attachment-download");
    expect(safeFilename("CON", "fallback")).toBe("CON_");
    expect(safeFilename("nul", "fallback")).toBe("nul_");
    expect(safeFilename("COM1", "fallback")).toBe("COM1_");
    expect(safeFilename("lpt9", "fallback")).toBe("lpt9_");
    // An ordinary name is untouched.
    expect(safeFilename("CONsole.csv", "fallback")).toBe("CONsole.csv");
  });
});
