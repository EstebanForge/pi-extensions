// Unit tests for the format helpers. These are pure functions so the matrix
// is fully deterministic.

import { describe, expect, it } from "vitest";
import {
  describeTitleBodyPayload,
  describeReviewPayload,
  formatCommitMessage,
  oneLine,
} from "../lib/format";

describe("oneLine", () => {
  it("collapses whitespace", () => {
    expect(oneLine("  hello\n  world\t!  ")).toBe("hello world !");
  });

  it("caps length with ellipsis", () => {
    const long = "x".repeat(500);
    const out = oneLine(long);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });

  it("returns short strings unchanged", () => {
    expect(oneLine("hi")).toBe("hi");
  });
});

describe("formatCommitMessage", () => {
  it("subject only", () => {
    expect(formatCommitMessage("feat: add login")).toBe("feat: add login");
  });

  it("subject + body joined by blank line", () => {
    expect(formatCommitMessage("feat: add login", "adds the endpoint")).toBe(
      "feat: add login\n\nadds the endpoint",
    );
  });

  it("trims surrounding whitespace from body", () => {
    expect(formatCommitMessage("feat: x", "   body   ")).toBe("feat: x\n\nbody");
  });

  it("empty body falls back to subject", () => {
    expect(formatCommitMessage("feat: x", "   ")).toBe("feat: x");
  });
});

describe("describeTitleBodyPayload", () => {
  it("renders title + body summary", () => {
    const out = describeTitleBodyPayload("feat: add login", "Adds the login endpoint and tests.");
    expect(out).toContain("title: feat: add login");
    expect(out).toContain("Adds the login endpoint and tests.");
  });
});

describe("describeReviewPayload", () => {
  it("renders one-line body", () => {
    expect(describeReviewPayload("lgtm, ship it")).toBe("lgtm, ship it");
  });
});
