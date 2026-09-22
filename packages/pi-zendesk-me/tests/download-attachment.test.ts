import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAuthCache } from "../lib/auth";
import { downloadAttachmentTool } from "../lib/tools/download-attachment";
import {
  TOKEN_OK,
  fetchMock,
  firstText,
  invoke,
  isTokenRequest,
  jsonResponse,
  stubZendeskEnv,
} from "./_helpers";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetAuthCache();
  stubZendeskEnv();
});

const COMMENTS = {
  comments: [
    {
      id: 1,
      body: "<p>see screenshot</p>",
      public: true,
      author_id: 1042,
      created_at: "2026-08-27T14:45:00Z",
      attachments: [
        {
          id: 43038971788439,
          file_name: "Screenshot 2026-08-27.png",
          content_url: "https://storage.example/signed/abc",
          content_type: "image/png",
          size: 8,
        },
      ],
    },
  ],
};

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function routeWithStorage(body: Uint8Array) {
  return fetchMock((url, init) => {
    if (isTokenRequest(url)) return jsonResponse(TOKEN_OK);
    if (url.includes("/api/v2/tickets/7942/comments.json")) {
      return jsonResponse(COMMENTS);
    }
    if (url.startsWith("https://storage.example/")) {
      // The signed-URL download must NOT carry the bearer token (it breaks
      // the storage signature).
      const hasAuth = Boolean(
        (init?.headers as Record<string, string> | undefined)?.Authorization,
      );
      if (hasAuth) return new Response("forbidden", { status: 403 });
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }
    return jsonResponse({}, 404);
  });
}

describe("zendesk_download_attachment", () => {
  it("downloads by attachment id and writes to the temp dir", async () => {
    routeWithStorage(PNG_BYTES);

    const result = await invoke(downloadAttachmentTool, {
      ticket: "7942",
      attachment: 43038971788439,
    });
    const text = firstText(result);

    expect(text).toContain("Downloaded: ");
    expect(text).toContain("image/png");
    expect(text).toContain("from comment #1");
    expect(text).toContain("`read` tool");

    const filePath = text.split("Downloaded: ")[1]!.split("\n")[0]!;
    expect(filePath.startsWith(path.join(tmpdir(), "pi-zendesk-me"))).toBe(
      true,
    );
    expect(path.basename(filePath)).toContain("Screenshot_2026-08-27.png");
    const written = await readFile(filePath);
    expect([...written]).toEqual([...PNG_BYTES]);

    await rm(path.join(tmpdir(), "pi-zendesk-me"), {
      recursive: true,
      force: true,
    });
  });

  it("rejects an unparseable ticket reference", async () => {
    const result = await invoke(downloadAttachmentTool, {
      ticket: "junk",
      attachment: 1,
    });
    expect(firstText(result)).toContain("Invalid ticket reference");
  });

  it("lists available attachment ids when the id is not found", async () => {
    routeWithStorage(PNG_BYTES);

    const result = await invoke(downloadAttachmentTool, {
      ticket: "7942",
      attachment: 42,
    });
    const text = firstText(result);

    expect(text).toContain("Attachment 42 not found on ticket 7942");
    expect(text).toContain("#43038971788439 Screenshot 2026-08-27.png");
  });

  it("surfaces storage download failures through the error formatter", async () => {
    fetchMock((url) => {
      if (isTokenRequest(url)) return jsonResponse(TOKEN_OK);
      if (url.includes("/api/v2/tickets/7942/comments.json")) {
        return jsonResponse(COMMENTS);
      }
      return new Response("gone", { status: 410 });
    });

    const result = await invoke(downloadAttachmentTool, {
      ticket: "https://{subdomain}.zendesk.com/agent/tickets/7942",
      attachment: 43038971788439,
    });
    expect(firstText(result)).toContain("Zendesk error:");
    expect(firstText(result)).toContain("HTTP 410");
  });
});
