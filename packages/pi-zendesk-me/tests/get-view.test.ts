import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAuthCache } from "../lib/auth";
import { getViewTool } from "../lib/tools/get-view";
import { parseViewRef } from "../lib/url";
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

describe("parseViewRef", () => {
  it("accepts bare ids and /filters/ and /views/ URLs", () => {
    expect(parseViewRef("20824934716439")).toBe(20824934716439);
    expect(
      parseViewRef("https://{subdomain}.zendesk.com/agent/filters/20824934716439"),
    ).toBe(20824934716439);
    expect(
      parseViewRef("https://{subdomain}.zendesk.com/agent/views/42"),
    ).toBe(42);
    expect(parseViewRef("nonsense")).toBeNull();
  });
});

function route(handler: (url: string) => Response | Promise<Response>) {
  return fetchMock(async (url) => {
    if (isTokenRequest(url)) return jsonResponse(TOKEN_OK);
    return handler(url);
  });
}

const VIEW = { view: { id: 20824934716439, title: "Mine - Web Team", active: true } };
const EXEC = {
  count: 2,
  next_page: null,
  rows: [
    {
      ticket: {
        id: 7942,
        subject: "Manage Member button has disappeared in the dashboard",
        status: "open",
        priority: "urgent",
        requester_id: 1042,
        assignee_id: 2099,
        created_at: "2026-08-14T09:30:00Z",
      },
    },
    {
      ticket: {
        id: 7950,
        subject: "Email digest stopped",
        status: "pending",
        priority: "normal",
        requester_id: 2001,
        assignee_id: 2099,
        created_at: "2026-08-16T10:00:00Z",
      },
    },
  ],
  users: [
    { id: 1042, name: "Ada Lovelace", active: true, role: "end-user" },
    { id: 2099, name: "Grace Agent", active: true, role: "agent" },
  ],
  organizations: [{ id: 77, name: "Analytical Engines Ltd", active: true }],
};

describe("zendesk_get_view", () => {
  it("rejects an unparseable view reference", async () => {
    const result = await invoke(getViewTool, { view: "nope" });
    expect(firstText(result)).toContain("Invalid view reference");
  });

  it("renders title and tickets with resolved people from a filter URL", async () => {
    const mock = route((url) => {
      if (url.includes("/api/v2/views/20824934716439/execute.json")) {
        return jsonResponse(EXEC);
      }
      if (url.includes("/api/v2/views/20824934716439.json")) {
        return jsonResponse(VIEW);
      }
      return jsonResponse({}, 404);
    });

    const result = await invoke(getViewTool, {
      view: "https://{subdomain}.zendesk.com/agent/filters/20824934716439",
    });
    const text = firstText(result);

    expect(text).toContain("View #20824934716439 - Mine - Web Team");
    expect(text).toContain("2 matching tickets");
    expect(text).toContain(
      "#7942 [open] Manage Member button has disappeared in the dashboard (urgent)",
    );
    expect(text).toContain("#7950 [pending] Email digest stopped");

    const [execUrl] = mock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("execute.json"));
    expect(execUrl).toContain("per_page=25");
    expect(execUrl).toContain("include=");
  });

  it("respects the limit param and reports empty views", async () => {
    route((url) => {
      if (url.includes("execute.json")) {
        return jsonResponse({ count: 0, next_page: null, rows: [] });
      }
      return jsonResponse(VIEW);
    });

    const result = await invoke(getViewTool, { view: "20824934716439", limit: 10 });
    const text = firstText(result);

    expect(text).toContain("0 matching tickets");
    expect(text).toContain("(no matching tickets)");
  });

  it("maps API errors through the shared error formatter", async () => {
    route(() => jsonResponse({ error: "Forbidden" }, 403));

    const result = await invoke(getViewTool, { view: "20824934716439" });
    expect(firstText(result)).toContain("Zendesk error:");
  });
});
