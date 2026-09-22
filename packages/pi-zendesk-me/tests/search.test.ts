import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAuthCache } from "../lib/auth";
import { effectiveQuery, searchTool } from "../lib/tools/search";
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

describe("effectiveQuery", () => {
  it("prepends type:ticket for plain queries", () => {
    expect(effectiveQuery("billing urgent", false)).toBe(
      "type:ticket billing urgent",
    );
  });

  it("leaves queries that already pin a type", () => {
    expect(effectiveQuery("type:organization acme", false)).toBe(
      "type:organization acme",
    );
  });

  it("all_types disables the default", () => {
    expect(effectiveQuery("billing", true)).toBe("billing");
  });
});

describe("zendesk_search", () => {
  it("searches tickets and renders result lines", async () => {
    const mock = fetchMock((url) => {
      if (isTokenRequest(url)) return jsonResponse(TOKEN_OK);
      if (url.includes("/api/v2/search.json")) {
        return jsonResponse({
          count: 2,
          next_page: null,
          previous_page: null,
          results: [
            {
              result_type: "ticket",
              id: 7942,
              subject: "Cannot login to portal",
              status: "open",
              priority: "high",
              requester_id: 1042,
              created_at: "2026-08-14T09:30:00Z",
            },
            {
              result_type: "ticket",
              id: 7901,
              subject: "SSO loop after password change",
              status: "solved",
              priority: "normal",
              requester_id: 2001,
              created_at: "2026-08-01T08:00:00Z",
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await invoke(searchTool, { query: "login" });
    const text = firstText(result);

    expect(text).toContain("2 results for: type:ticket login");
    expect(text).toContain("#7942 [open] Cannot login to portal (high)");
    expect(text).toContain("#7901 [solved] SSO loop after password change");
    expect(text).toContain("#7942: created 2026-08-14 09:30 UTC");

    const [url] = mock.mock.calls.find(
      (c) => !isTokenRequest(String(c[0])),
    ) as unknown as [string];
    expect(url).toContain("query=type%3Aticket+login");
    expect(url).toContain("per_page=25");
  });

  it("reports empty result sets plainly", async () => {
    fetchMock((url) => {
      if (isTokenRequest(url)) return jsonResponse(TOKEN_OK);
      return jsonResponse({
        count: 0,
        next_page: null,
        previous_page: null,
        results: [],
      });
    });

    const result = await invoke(searchTool, { query: "zzz-nothing" });
    expect(firstText(result)).toContain(
      "No results for: type:ticket zzz-nothing",
    );
  });

  it("notes pagination when more results exist", async () => {
    fetchMock((url) => {
      if (isTokenRequest(url)) return jsonResponse(TOKEN_OK);
      return jsonResponse({
        count: 40,
        next_page:
          "https://{subdomain}.zendesk.com/api/v2/search.json?page=2",
        previous_page: null,
        results: [
          {
            result_type: "ticket",
            id: 1,
            subject: "a",
            status: "open",
            priority: "low",
            requester_id: 5,
            created_at: "2026-08-14T09:30:00Z",
          },
        ],
      });
    });

    const result = await invoke(searchTool, { query: "open" });
    expect(firstText(result)).toContain(
      "showing first 1 - narrow the query to refine",
    );
  });
});
