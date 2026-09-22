import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke, firstText } from "./_helpers";
import { setConfirmWriteEnabled } from "../lib/confirm";

// Image-attachment tests for asana_add_comment. fetch is routed by URL shape:
// /attachments (multipart upload) vs /stories (JSON story post). The multipart
// body arrives as a FormData instance, which the tests read back directly.

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-asana-img-"));
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  process.env.ASANA_ACCESS_TOKEN = "pat-test";
  setConfirmWriteEnabled(false);
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.ASANA_ACCESS_TOKEN;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function writePng(name: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return path;
}

interface Call {
  url: string;
  init: RequestInit;
}

// Route: /attachments -> attachment compact record (assigns sequential gids);
// /stories -> story record. Returns the captured calls for assertions.
function mockAsana(opts: { attachmentsToFail?: number[]; storyStatus?: number } = {}) {
  const calls: Call[] = [];
  let attachmentIndex = 0;
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    if (String(url).includes("/attachments")) {
      attachmentIndex += 1;
      if (opts.attachmentsToFail?.includes(attachmentIndex)) {
        return {
          ok: false,
          status: 422,
          text: async () =>
            JSON.stringify({ errors: [{ message: "could not read file" }] }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { gid: `1200${attachmentIndex}`, name: `img${attachmentIndex}`, resource_subtype: "asana" },
        }),
      } as unknown as Response;
    }
    if (String(url).includes("/stories")) {
      if (opts.storyStatus) {
        return {
          ok: false,
          status: opts.storyStatus,
          text: async () =>
            JSON.stringify({ errors: [{ message: "task not found" }] }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({
          data: { gid: "story1", text: "", created_at: "2026-09-05T00:00:00.000Z" },
        }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: {} }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

async function runTool(params: Record<string, unknown>): Promise<string> {
  const { addCommentTool } = await import("../lib/tools/comment-add");
  return firstText(
    await invoke(addCommentTool, params, {
      hasUI: true,
      ui: { confirm: vi.fn(), editor: vi.fn().mockResolvedValue("final text") },
    }),
  );
}

async function storyBody(calls: Call[]): Promise<Record<string, unknown>> {
  const storyCall = calls.find((c) => String(c.url).includes("/stories"))!;
  // callAsana wraps every write body in a top-level {data: ...} envelope.
  const wire = JSON.parse(storyCall.init.body as string) as Record<string, unknown>;
  return (wire.data as Record<string, unknown>) ?? wire;
}

describe("asana_add_comment images", () => {
  it("refuses unsupported file types before any network call", async () => {
    const { fetchMock } = mockAsana();
    const text = await runTool({
      task_gid: "111",
      text: "hi",
      images: [join(tmpDir, "notes.txt")],
    });
    expect(text).toMatch(/unsupported type/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses missing files before any network call", async () => {
    const { fetchMock } = mockAsana();
    const text = await runTool({
      task_gid: "111",
      text: "hi",
      images: [join(tmpDir, "gone.png")],
    });
    expect(text).toMatch(/file not found/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads each image with parent=task and embeds inline img tags in the story", async () => {
    const png = writePng("shot.png");
    const { calls } = mockAsana();

    const text = await runTool({ task_gid: "111", text: "final text", images: [png] });

    expect(text).toMatch(/comment added to task 111/);
    expect(text).toMatch(/Attached 1 image\(s\): shot\.png/);
    const upload = calls.find((c) => String(c.url).includes("/attachments"))!;
    expect(String(upload.url)).toMatch(/\/attachments$/);
    const form = upload.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("parent")).toBe("111");
    // No resource_subtype: the default ("asana") is required for inline
    // rendering; "external" attachments are rejected as inline images.
    expect(form.has("resource_subtype")).toBe(false);
    const filePart = form.get("file") as File;
    expect(filePart.name).toBe("shot.png");
    expect(filePart.type).toBe("image/png");

    const body = await storyBody(calls);
    const html = String(body.html_text);
    expect(html).toBe(
      "<body>final text\n<img data-asana-gid=\"12001\" alt=\"shot.png\"/></body>",
    );
    expect(body.text).toBeUndefined();
  });

  it("escapes XML-special characters in plain-text comments", async () => {
    const png = writePng("shot.png");
    const { calls } = mockAsana();
    await runTool({ task_gid: "111", text: "a < b & c", images: [png] });
    const body = await storyBody(calls);
    expect(String(body.html_text)).toContain("<body>a &lt; b &amp; c");
  });

  it("splices img tags before </body> when html=true", async () => {
    const png = writePng("shot.png");
    const { calls } = mockAsana();
    await runTool({
      task_gid: "111",
      html: true,
      text: "<body>Look <strong>here</strong></body>",
      images: [png],
    });
    const body = await storyBody(calls);
    expect(String(body.html_text)).toBe(
      '<body>Look <strong>here</strong>\n<img data-asana-gid="12001" alt="shot.png"/></body>',
    );
  });

  it("uploads every image and embeds them in order", async () => {
    writePng("one.png");
    writePng("two.png");
    const { calls } = mockAsana();
    const text = await runTool({
      task_gid: "111",
      text: "final text",
      images: [join(tmpDir, "one.png"), join(tmpDir, "two.png")],
    });
    expect(text).toMatch(/Attached 2 image\(s\): one\.png, two\.png/);
    const body = await storyBody(calls);
    const html = String(body.html_text);
    expect(html).toContain('<img data-asana-gid="12001" alt="one.png"/>');
    expect(html).toContain('<img data-asana-gid="12002" alt="two.png"/>');
    expect(html.indexOf("one.png")).toBeLessThan(html.indexOf("two.png"));
  });

  it("reports partial attachment state and posts NO story when an upload fails", async () => {
    writePng("one.png");
    writePng("two.png");
    const { calls } = mockAsana({ attachmentsToFail: [2] });
    const text = await runTool({
      task_gid: "111",
      text: "final text",
      images: [join(tmpDir, "one.png"), join(tmpDir, "two.png")],
    });
    expect(text).toMatch(/failed uploading image 2\/2 \(two\.png\)/);
    expect(text).toMatch(/Already attached \(kept on the task\): one\.png/);
    expect(text).toMatch(/Comment NOT posted/);
    expect(calls.some((c) => String(c.url).includes("/stories"))).toBe(false);
  });

  it("reports that attachments remain when the story post fails", async () => {
    const png = writePng("shot.png");
    const { calls } = mockAsana({ storyStatus: 404 });
    const text = await runTool({ task_gid: "111", text: "final text", images: [png] });
    expect(text).toMatch(/not found|404/);
    // The upload DID happen before the story failed - the file stays on the task.
    expect(calls.some((c) => String(c.url).includes("/attachments"))).toBe(true);
  });

  it("posts plain text stories untouched when no images are given", async () => {
    const { calls } = mockAsana();
    await runTool({ task_gid: "111", text: "final text" });
    const body = await storyBody(calls);
    expect(body).toEqual({ text: "final text" });
    expect(calls.some((c) => String(c.url).includes("/attachments"))).toBe(false);
  });
});
