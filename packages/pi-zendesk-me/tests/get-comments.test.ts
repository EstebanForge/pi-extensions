import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAuthCache } from "../lib/auth";
import { getCommentsTool } from "../lib/tools/get-comments";
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
  _resetAuthCache();
  stubZendeskEnv();
});

function route(handler: (url: string) => Response | Promise<Response>) {
  return fetchMock(async (url) => {
    if (isTokenRequest(url)) return jsonResponse(TOKEN_OK);
    return handler(url);
  });
}

const COMMENTS_RESPONSE = {
  comments: [
    {
      id: 1,
      body: "<p>I cannot log in at all.</p>",
      public: true,
      author_id: 1042,
      created_at: "2026-08-14T09:30:00Z",
    },
    {
      id: 2,
      body: "<p>Internal: user is on an old plan, check entitlements.</p>",
      public: false,
      author_id: 2099,
      created_at: "2026-08-14T10:00:00Z",
    },
    {
      id: 3,
      body: "<p>We pushed a fix, please retry.</p>",
      public: true,
      author_id: 2099,
      created_at: "2026-08-15T11:00:00Z",
      attachments: [
        { id: 900, file_name: "fix-notes.pdf", size: 2048 },
      ],
    },
  ],
  users: [
    { id: 1042, name: "Ada Lovelace", active: true, role: "end-user" },
    { id: 2099, name: "Grace Agent", active: true, role: "agent" },
  ],
};

describe("zendesk_get_comments", () => {
  it("renders the thread oldest-first with visibility flags", async () => {
    route((url) =>
      url.includes("/api/v2/tickets/7942/comments.json")
        ? jsonResponse(COMMENTS_RESPONSE)
        : jsonResponse({}, 404),
    );

    const result = await invoke(getCommentsTool, { ticket: "7942" });
    const text = firstText(result);

    expect(text).toContain("Ticket #7942: 3 entries");
    expect(text).toContain("Ada Lovelace - public reply");
    expect(text).toContain("Grace Agent - INTERNAL NOTE");
    expect(text).toContain("I cannot log in at all.");
    expect(text).toContain("attachment: #900 fix-notes.pdf (2048 bytes)");
    expect(text).not.toContain("<p>");
    // Newest last: the fix reply appears after the internal note.
    expect(text.indexOf("Internal: user is on an old plan")).toBeLessThan(
      text.indexOf("We pushed a fix"),
    );
  });

  it("limits rendering to the N most recent and counts the hidden tail", async () => {
    route((url) =>
      url.includes("/api/v2/tickets/7942/comments.json")
        ? jsonResponse(COMMENTS_RESPONSE)
        : jsonResponse({}, 404),
    );

    const result = await invoke(getCommentsTool, {
      ticket: "7942",
      limit: 1,
    });
    const text = firstText(result);

    expect(text).toContain("showing 1 most recent, 2 oldest hidden");
    expect(text).toContain("We pushed a fix");
    expect(text).not.toContain("I cannot log in at all.");
  });

  it("public_only drops internal notes", async () => {
    route((url) =>
      url.includes("/api/v2/tickets/7942/comments.json")
        ? jsonResponse(COMMENTS_RESPONSE)
        : jsonResponse({}, 404),
    );

    const result = await invoke(getCommentsTool, {
      ticket: "7942",
      public_only: true,
    });
    const text = firstText(result);

    expect(text).toContain("2 entries (public replies only)");
    expect(text).not.toContain("INTERNAL NOTE");
  });

  it("rejects an unparseable ticket reference", async () => {
    const result = await invoke(getCommentsTool, { ticket: "nope" });
    expect(firstText(result)).toContain("Invalid ticket reference");
  });
});
