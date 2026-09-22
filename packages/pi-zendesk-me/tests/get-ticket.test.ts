import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAuthCache } from "../lib/auth";
import { getTicketTool } from "../lib/tools/get-ticket";
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

const TICKET_RESPONSE = {
  ticket: {
    id: 7942,
    subject: "Cannot login to portal",
    description: "<p>Password reset emails <b>never arrive</b>.</p>",
    status: "open",
    priority: "high",
    type: "incident",
    requester_id: 1042,
    submitter_id: 1042,
    assignee_id: 2099,
    organization_id: 77,
    group_id: 1,
    tags: ["login", "email"],
    created_at: "2026-08-14T09:30:00Z",
    updated_at: "2026-08-15T11:00:00Z",
  },
  users: [
    {
      id: 1042,
      name: "Ada Lovelace",
      email: "ada@example.com",
      active: true,
      role: "end-user",
    },
    {
      id: 2099,
      name: "Grace Agent",
      active: true,
      role: "agent",
    },
  ],
  organizations: [
    { id: 77, name: "Analytical Engines Ltd", active: true },
  ],
};

describe("zendesk_get_ticket", () => {
  it("rejects an unparseable ticket reference", async () => {
    const result = await invoke(getTicketTool, { ticket: "banana" });
    expect(firstText(result)).toContain("Invalid ticket reference");
  });

  it("fetches by bare id and renders people from side-loads", async () => {
    const mock = route((url) =>
      url.includes("/api/v2/tickets/7942.json")
        ? jsonResponse(TICKET_RESPONSE)
        : jsonResponse({}, 404),
    );

    const result = await invoke(getTicketTool, { ticket: "7942" });
    const text = firstText(result);

    expect(text).toContain("Ticket #7942 - [open] Cannot login to portal");
    expect(text).toContain("Requester: Ada Lovelace <ada@example.com>");
    expect(text).toContain("Assignee: Grace Agent");
    expect(text).toContain("Organization: Analytical Engines Ltd");
    expect(text).toContain("Priority: high");
    expect(text).toContain("Tags: login, email");
    expect(text).toContain("Password reset emails never arrive.");
    expect(text).not.toContain("<p>");

    const [url] = mock.mock.calls.find(
      (c) => !isTokenRequest(String(c[0])),
    ) as unknown as [string];
    expect(url).toContain("tickets/7942.json");
    expect(url).toContain("include=");
  });

  it("fetches from a pasted agent URL", async () => {
    route((url) =>
      url.includes("/api/v2/tickets/7942.json")
        ? jsonResponse(TICKET_RESPONSE)
        : jsonResponse({}, 404),
    );

    const result = await invoke(getTicketTool, {
      ticket: "https://{subdomain}.zendesk.com/agent/tickets/7942",
    });
    expect(firstText(result)).toContain("Ticket #7942");
  });

  it("maps API errors through the shared error formatter", async () => {
    route(() =>
      jsonResponse(
        { error: "RecordNotFound", description: "Ticket 7942 not found" },
        404,
      ),
    );

    const result = await invoke(getTicketTool, { ticket: "7942" });
    expect(firstText(result)).toContain("Zendesk error:");
  });
});
