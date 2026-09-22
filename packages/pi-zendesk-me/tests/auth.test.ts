import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ZendeskAuthError,
  _resetAuthCache,
  getZendeskAccessToken,
  getZendeskCredentials,
  requestZendeskAccessToken,
} from "../lib/auth";
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

describe("getZendeskCredentials", () => {
  it("returns the three credentials when set", () => {
    const creds = getZendeskCredentials();
    expect(creds).toEqual({
      subdomain: "{subdomain}",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });
  });

  it("throws a rich error listing every missing var", () => {
    vi.stubEnv("ZENDESK_SUBDOMAIN", "");
    vi.stubEnv("ZENDESK_CLIENT_SECRET", "");
    expect(() => getZendeskCredentials()).toThrow(ZendeskAuthError);
    expect(() => getZendeskCredentials()).toThrow(
      /ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_SECRET/,
    );
  });

  it("the missing-env error mentions the deprecation deadline", () => {
    vi.stubEnv("ZENDESK_CLIENT_ID", "");
    expect(() => getZendeskCredentials()).toThrow(/2027-04-30/);
  });
});

describe("requestZendeskAccessToken", () => {
  it("POSTs client_credentials to the tenant token endpoint", async () => {
    const mock = fetchMock((url) =>
      isTokenRequest(url) ? jsonResponse(TOKEN_OK) : jsonResponse({}, 404),
    );

    const token = await requestZendeskAccessToken();

    expect(token).toBe("test-access-token");
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://{subdomain}.zendesk.com/oauth/tokens");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const body = String(init.body);
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("client_id=test-client-id");
    expect(body).toContain("client_secret=test-client-secret");
    expect(body).toContain("scope=tickets%3Aread+users%3Aread+organizations%3Aread");
  });

  it("surfaces Zendesk's OAuth error code (invalid_scope)", async () => {
    fetchMock(() =>
      jsonResponse(
        {
          error: "invalid_scope",
          error_description: "The requested scope is invalid.",
        },
        400,
      ),
    );

    await expect(requestZendeskAccessToken()).rejects.toThrow(
      /Allowed scopes.*invalid_scope/s,
    );
  });

  it("surfaces a non-JSON failure with the HTTP status", async () => {
    fetchMock(() => new Response("gateway timeout", { status: 504 }));
    await expect(requestZendeskAccessToken()).rejects.toThrow(/HTTP 504/);
  });

  it("rejects a 200 body without access_token", async () => {
    fetchMock(() => jsonResponse({ token_type: "bearer" }));
    await expect(requestZendeskAccessToken()).rejects.toThrow(
      /token request failed/,
    );
  });
});

describe("getZendeskAccessToken cache", () => {
  it("requests once and serves the second call from cache", async () => {
    const mock = fetchMock((url) =>
      isTokenRequest(url) ? jsonResponse(TOKEN_OK) : jsonResponse({}, 404),
    );

    await getZendeskAccessToken();
    await getZendeskAccessToken();

    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("re-requests after resetTokenCache", async () => {
    const mock = fetchMock((url) =>
      isTokenRequest(url) ? jsonResponse(TOKEN_OK) : jsonResponse({}, 404),
    );

    await getZendeskAccessToken();
    const { resetTokenCache } = await import("../lib/auth");
    resetTokenCache();
    await getZendeskAccessToken();

    expect(mock).toHaveBeenCalledTimes(2);
  });
});
