// Image-attachment tests for the git-me comment tools (pr/issue/discussion).
//
// `node:child_process` is mocked (same pattern as tools.test.ts) so no test
// shells out to real git/gh, and global fetch is stubbed so no test touches
// uploads.github.com. The upload path spawns `gh auth token` + `gh api
// repos/<owner>/<repo>` and then POSTs the bytes; the assertions pin the
// request shape, the appended markdown, and the "no comment on failed upload"
// ordering guarantee.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- child_process mock (copied shape from tools.test.ts) -------------------
const { cpMock } = vi.hoisted(() => {
  type FakeResult = { stdout: string; stderr: string; status: number };
  type Route = {
    match: (cmd: string, args: string[]) => boolean;
    result: () => FakeResult;
  };
  const state: {
    routes: Route[];
    calls: Array<{ cmd: string; args: string[]; cwd?: string }>;
  } = { routes: [], calls: [] };
  const spawnSyncMock = (
    cmd: string,
    args: string[],
    opts?: { cwd?: string },
  ): FakeResult => {
    state.calls.push({ cmd, args: [...args], cwd: opts?.cwd });
    for (const route of state.routes) {
      if (route.match(cmd, args)) return route.result();
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  const spawnStub = (): never => {
    throw new Error("tests: async spawn is not mocked here");
  };
  return { cpMock: { state, spawnSyncMock, spawnStub } };
});

vi.mock("node:child_process", () => ({
  spawnSync: cpMock.spawnSyncMock,
  spawn: cpMock.spawnStub,
}));

import { _resetAuthCache } from "../lib/auth";
import { prCommentTool } from "../lib/tools/pr-comment";
import { issueCommentTool } from "../lib/tools/issue-comment";
import { discussionCommentTool } from "../lib/tools/discussion-comment";
import { invokeWithCtx, makeCtx, makeStubUI, firstText } from "./_helpers";

type Route = { match: (c: string, a: string[]) => boolean; result: () => { stdout: string; stderr: string; status: number } };

function baseRoutes(): Route[] {
  return [
    { match: (c, a) => c === "git" && a[0] === "rev-parse" && a.includes("--is-inside-work-tree"), result: () => ({ stdout: "true", stderr: "", status: 0 }) },
    { match: (c, a) => c === "gh" && a[0] === "--version", result: () => ({ stdout: "gh version 2.100.0", stderr: "", status: 0 }) },
    { match: (c, a) => c === "gh" && a[0] === "auth" && a[1] === "status", result: () => ({ stdout: "", stderr: "", status: 0 }) },
    { match: (c, a) => c === "gh" && a[0] === "auth" && a[1] === "token", result: () => ({ stdout: "tok-test\n", stderr: "", status: 0 }) },
    { match: (c, a) => c === "gh" && a[0] === "api" && a[1] === "repos/octo/repo", result: () => ({ stdout: "12345", stderr: "", status: 0 }) },
    { match: (c, a) => c === "gh" && a[0] === "api" && a[1] === "graphql" && a.some((arg) => arg.startsWith("query=") && arg.includes("discussion(")), result: () => ({ stdout: JSON.stringify({ data: { repository: { discussion: { id: "DIC1", title: "T", url: "https://github.com/octo/repo/discussions/3" } } } }), stderr: "", status: 0 }) },
    { match: (c, a) => c === "gh" && a[0] === "api" && a[1] === "graphql" && a.some((arg) => arg.startsWith("query=") && arg.includes("addDiscussionComment")), result: () => ({ stdout: JSON.stringify({ data: { addDiscussionComment: { comment: { url: "https://github.com/octo/repo/discussions/3#comment-9" } } } }), stderr: "", status: 0 }) },
    { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "comment", result: () => ({ stdout: "", stderr: "", status: 0 }) },
    { match: (c, a) => c === "gh" && a[0] === "issue" && a[1] === "comment", result: () => ({ stdout: "", stderr: "", status: 0 }) },
    { match: (c, a) => c === "gh" && a[0] === "repo" && a[1] === "view", result: () => ({ stdout: JSON.stringify({ id: "REPOID", nameWithOwner: "octo/repo" }), stderr: "", status: 0 }) },
  ];
}

// --- uploads.github.com fetch stub ------------------------------------------
const UPLOAD_URL = "https://github.com/user-attachments/assets/deadbeef";
let uploadCalls: Array<{ url: string; init: RequestInit }>;

function stubUploadFetch(opts: { status?: number } = {}) {
  uploadCalls = [];
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("https://uploads.github.com/user-attachments/assets")) {
      uploadCalls.push({ url: String(url), init: init ?? {} });
      const status = opts.status ?? 201;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => "",
        json: async () => ({ url: UPLOAD_URL }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-git-img-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  _resetAuthCache();
  cpMock.state.routes = baseRoutes();
  cpMock.state.calls = [];
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  _resetAuthCache();
});

function writePng(name: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return path;
}

function findGhCall(prefix: string[]) {
  return cpMock.state.calls.find(
    (c) => c.cmd === "gh" && c.args.slice(0, prefix.length).join(" ") === prefix.join(" "),
  );
}

async function run(
  tool: Parameters<typeof invokeWithCtx>[0],
  params: Record<string, unknown>,
  editorResponse: string | undefined = "posted body",
): Promise<string> {
  const ui = makeStubUI({ editorResponse });
  const result = await invokeWithCtx(tool, params, makeCtx(ui, { cwd: tempDir }));
  return firstText(result);
}

describe("comment image attachments", () => {
  it("refuses unsupported types before the gate and before any network call", async () => {
    const fetchMock = stubUploadFetch();
    const text = await run(prCommentTool, {
      pr: 1,
      body: "hello",
      images: [join(tempDir, "notes.pdf")],
    });
    expect(text).toMatch(/unsupported type/i);
    expect(text).toMatch(/png/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cpMock.state.calls.some((c) => c.cmd === "gh" && c.args[0] === "pr")).toBe(false);
  });

  it("refuses missing files before the gate", async () => {
    stubUploadFetch();
    const text = await run(issueCommentTool, {
      number: 7,
      body: "hello",
      images: [join(tempDir, "gone.png")],
    });
    expect(text).toMatch(/file not found/i);
  });

  it("cancelling at the gate uploads nothing", async () => {
    const png = writePng("shot.png");
    const fetchMock = stubUploadFetch();
    // Call invokeWithCtx directly: run()'s default editorResponse would make
    // explicit undefined impossible to express.
    const ui = makeStubUI({ editorResponse: undefined });
    await invokeWithCtx(prCommentTool, { pr: 1, body: "hello", images: [png] }, makeCtx(ui, { cwd: tempDir }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findGhCall(["pr", "comment"])).toBeUndefined();
  });

  it("uploads the image then appends its markdown to the PR comment body", async () => {
    const png = writePng("shot.png");
    stubUploadFetch();
    const text = await run(prCommentTool, { pr: 1, body: "posted body", images: [png] });

    expect(uploadCalls).toHaveLength(1);
    const call = uploadCalls[0];
    const parsed = new URL(call.url);
    expect(parsed.pathname).toBe("/user-attachments/assets");
    expect(parsed.searchParams.get("name")).toBe("shot.png");
    expect(parsed.searchParams.get("content_type")).toBe("image/png");
    expect(parsed.searchParams.get("repository_id")).toBe("12345");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer tok-test");
    expect((call.init.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");

    const post = findGhCall(["pr", "comment"])!;
    expect(post.args).toEqual(["pr", "comment", "1", "--body", `posted body\n\n![shot.png](${UPLOAD_URL})`]);
    expect(text).toMatch(/Posted comment on PR #1\. Attached 1 image\(s\)\./);
  });

  it("uploads every image and appends markdown in order on an issue comment", async () => {
    writePng("one.png");
    writePng("two.png");
    stubUploadFetch();
    const text = await run(issueCommentTool, {
      number: 7,
      body: "posted body",
      images: [join(tempDir, "one.png"), join(tempDir, "two.png")],
    });
    expect(uploadCalls).toHaveLength(2);
    expect(uploadCalls[0].url).toContain("name=one.png");
    expect(uploadCalls[1].url).toContain("name=two.png");
    const post = findGhCall(["issue", "comment"])!;
    expect(post.args[4]).toBe(
      `posted body\n\n![one.png](${UPLOAD_URL})\n![two.png](${UPLOAD_URL})`,
    );
    expect(text).toMatch(/Posted comment on issue #7\. Attached 2 image\(s\)\./);
  });

  it("attaches images on discussion comments through the same upload path", async () => {
    const png = writePng("shot.png");
    stubUploadFetch();
    const text = await run(discussionCommentTool, {
      number: 3,
      body: "posted body",
      images: [png],
    });
    expect(uploadCalls).toHaveLength(1);
    const graphql = cpMock.state.calls.find(
      (c) => c.cmd === "gh" && c.args[0] === "api" && c.args[1] === "graphql" &&
        c.args.some((arg) => arg.startsWith("query=") && arg.includes("addDiscussionComment")),
    )!;
    const bodyArg = graphql.args.find((a) => a.startsWith("body="))!;
    expect(bodyArg).toBe(`body=posted body\n\n![shot.png](${UPLOAD_URL})`);
    expect(text).toMatch(/Comment posted on discussion #3\. Attached 1 image\(s\)\./);
  });

  it("posts NO comment when the upload fails (404 = no write access)", async () => {
    const png = writePng("shot.png");
    stubUploadFetch({ status: 404 });
    const text = await run(prCommentTool, { pr: 1, body: "posted body", images: [png] });
    expect(text).toMatch(/upload failed \(HTTP 404\)/);
    expect(text).toMatch(/WRITE access/);
    expect(text).toMatch(/Comment NOT posted/);
    expect(findGhCall(["pr", "comment"])).toBeUndefined();
  });

  it("names already-uploaded files when a LATER image fails (no silent orphans)", async () => {
    writePng("one.png");
    writePng("two.png");
    // First call succeeds (201 default), the rest 404.
    uploadCalls = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://uploads.github.com/user-attachments/assets")) {
        const status = uploadCalls.length === 0 ? 201 : 404;
        uploadCalls.push({ url: String(url), init: init ?? {} });
        return {
          ok: status < 300,
          status,
          text: async () => "",
          json: async () => ({ url: UPLOAD_URL }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await run(issueCommentTool, {
      number: 7,
      body: "b",
      images: [join(tempDir, "one.png"), join(tempDir, "two.png")],
    });
    expect(text).toMatch(/HTTP 404/);
    expect(text).toMatch(/Comment NOT posted/);
    expect(text).toMatch(/Already uploaded \(kept, unreferenced\): one\.png \(https:\/\/github\.com\/user-attachments\/assets\/deadbeef\)/);
    expect(findGhCall(["issue", "comment"])).toBeUndefined();
  });

  it("sanitizes markdown-breaking filenames in the appended alt text", async () => {
    const tricky = join(tempDir, "a]b[1].png");
    writeFileSync(tricky, Buffer.from("x"));
    stubUploadFetch();
    await run(issueCommentTool, { number: 7, body: "b", images: [tricky] });
    const post = findGhCall(["issue", "comment"])!;
    // ] and [ would terminate the ![alt](url) construct; they become spaces.
    // The posted body is the editor's response ("posted body"), not the draft.
    expect(post.args[4]).toBe(`posted body\n\n![a b 1 .png](${UPLOAD_URL})`);
  });

  it("names the allowed media list on a 422 content-type rejection", async () => {
    const clip = join(tempDir, "clip.webm");
    writeFileSync(clip, Buffer.from("x"));
    stubUploadFetch({ status: 422 });
    const text = await run(issueCommentTool, { number: 7, body: "b", images: [clip] });
    expect(text).toMatch(/HTTP 422/);
    expect(text).toMatch(/\.png, \.jpg/);
    expect(findGhCall(["issue", "comment"])).toBeUndefined();
  });
});
