import { describe, expect, it } from "vitest";
import { parseTicketRef } from "../lib/url";

describe("parseTicketRef", () => {
  it("accepts a bare numeric id", () => {
    expect(parseTicketRef("7942")).toBe(7942);
  });

  it("accepts a full agent URL", () => {
    expect(parseTicketRef("https://{subdomain}.zendesk.com/agent/tickets/7942")).toBe(
      7942,
    );
  });

  it("accepts an API URL containing /tickets/N", () => {
    expect(
      parseTicketRef("https://{subdomain}.zendesk.com/api/v2/tickets/12.json"),
    ).toBe(12);
  });

  it("trims whitespace", () => {
    expect(parseTicketRef("  7942  ")).toBe(7942);
  });

  it("returns null for non-ticket input", () => {
    expect(parseTicketRef("abc")).toBeNull();
    expect(parseTicketRef("")).toBeNull();
    expect(parseTicketRef("https://{subdomain}.zendesk.com/agent/")).toBeNull();
  });
});
