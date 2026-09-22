import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZendeskApiError, zdGet } from "../lib/api";
import { _resetAuthCache } from "../lib/auth";
import {
  TOKEN_OK,
  fetchMock,
  isTokenRequest,
  jsonResponse,
  stubZendeskEnv,
} from "./_helpers";

beforeEach(() => {
  vi.unstubAllEnvs();
  _resetAuthCache();
  stubZendeskEnv();
});

// Route token requests to a canned token; tests match API paths separately.
function route(handler: (url: string) => Response | Promise<Response>) {
  return fetchMock(async (url) => {
    if (isTokenRequest(url)) return jsonResponse(TOKEN_OK);
    return handler(url);
  });
}

describe("zdGet", () => {
  it("sends a Bearer header to the right API v2 URL", async () => {
    const mock = route((url) =>
      url.includes("/api/v2/tickets/7942.json")
        ? jsonResponse({ ticket: { id: 7942 } })
        : jsonResponse({}, 404),
    );

    const resp = await zdGet<{ ticket: { id: number } }>(
      "tickets/7942.json",
      { query: { include: "users,organizations" } },
    );

    expect(resp.ticket.id).toBe(7942);
    const [url, init] = mock.mock.calls.find(
      (c) => !isTokenRequest(String(c[0])),
    ) as unknown as [string, RequestInit];
    expect(url).toContain("https://{subdomain}.zendesk.com/api/v2/tickets/7942.json");
    expect(url).toContain("include=");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-access-token",
    );
  });

  it("re-tokens once on 401 invalid_token and retries", async () => {
    let apiCalls = 0;
    const mock = fetchMock((url) => {
      if (isTokenRequest(url)) return jsonResponse(TOKEN_OK);
      apiCalls += 1;
      if (apiCalls === 1) {
        return jsonResponse(
          { error: "invalid_token", description: "expired" },
          401,
        );
      }
      return jsonResponse({ ticket: { id: 7942 } });
    });

    const resp = await zdGet<{ ticket: { id: number } }>("tickets/7942.json");

    expect(resp.ticket.id).toBe(7942);
    // 2 token requests (initial + refresh) + 2 API calls (401 + retry).
    expect(mock).toHaveBeenCalledTimes(4);
    expect(apiCalls).toBe(2);
  });

  it("fails after invalid_token persists across the retry", async () => {
    fetchMock((url) =>
      isTokenRequest(url)
        ? jsonResponse(TOKEN_OK)
        : jsonResponse({ error: "invalid_token" }, 401),
    );

    await expect(zdGet("tickets/7942.json")).rejects.toThrow(
      /unauthorized even after refreshing/,
    );
  });

  it("fails fast on a non-invalid_token 401 without retrying", async () => {
    const mock = fetchMock((url) =>
      isTokenRequest(url)
        ? jsonResponse(TOKEN_OK)
        : jsonResponse({ error: "invalid_client" }, 401),
    );

    await expect(zdGet("tickets/7942.json")).rejects.toThrow(
      /unauthorized \(HTTP 401\)\. Check the OAuth/,
    );
    // No retry: one token request, one API call.
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("surfaces 429 with the Retry-After hint", async () => {
    route(() => jsonResponse({}, 429, { "Retry-After": "7" }));

    const err = await zdGet("tickets.json").catch((e) => e);
    expect(err).toBeInstanceOf(ZendeskApiError);
    expect((err as ZendeskApiError).isRateLimited).toBe(true);
    expect((err as ZendeskApiError).retryAfter).toBe(7);
    expect((err as ZendeskApiError).message).toContain("Retry in ~7s");
  });

  it("maps 403 to the scope-ceiling hint", async () => {
    route(() => jsonResponse({ error: "Forbidden" }, 403));

    const err = await zdGet("tickets.json").catch((e) => e);
    expect((err as ZendeskApiError).status).toBe(403);
    expect((err as ZendeskApiError).message).toMatch(/Allowed scopes/);
  });

  it("maps 404 to not-found with Zendesk's description", async () => {
    route(() =>
      jsonResponse(
        { error: "RecordNotFound", description: "Ticket 1 not found" },
        404,
      ),
    );

    const err = await zdGet("tickets/1.json").catch((e) => e);
    expect((err as ZendeskApiError).status).toBe(404);
    expect((err as ZendeskApiError).message).toContain("Ticket 1 not found");
  });

  it("maps 5xx to a retryable server error", async () => {
    route(() => new Response("oops", { status: 502 }));

    const err = await zdGet("tickets.json").catch((e) => e);
    expect((err as ZendeskApiError).status).toBe(502);
    expect((err as ZendeskApiError).message).toMatch(/server error/);
  });

  it("rejects non-JSON success bodies", async () => {
    route(() => new Response("<html>hi</html>", { status: 200 }));

    const err = await zdGet("tickets.json").catch((e) => e);
    expect((err as ZendeskApiError).message).toMatch(/non-JSON/);
  });
});
