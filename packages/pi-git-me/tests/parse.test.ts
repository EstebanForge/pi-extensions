// Unit tests for the parse helpers added in the ts-review cleanup. These
// are pure functions so the matrix is fully deterministic.

import { describe, expect, it } from "vitest";
import { parseDiffTarget } from "../lib/tools/diff";
import { parseReviewEvent } from "../lib/tools/pr-review";
import { parseGhFiles, parseGhPr, parseGitLog } from "../lib/git";

describe("parseDiffTarget", () => {
  it("accepts every documented target", () => {
    expect(parseDiffTarget("staged")).toBe("staged");
    expect(parseDiffTarget("unstaged")).toBe("unstaged");
    expect(parseDiffTarget("all")).toBe("all");
    expect(parseDiffTarget("branch")).toBe("branch");
  });

  it("defaults to 'unstaged' on undefined", () => {
    expect(parseDiffTarget(undefined)).toBe("unstaged");
  });

  it("defaults to 'unstaged' on unknown input", () => {
    expect(parseDiffTarget("bogus")).toBe("unstaged");
    expect(parseDiffTarget("")).toBe("unstaged");
    expect(parseDiffTarget("STAGED")).toBe("unstaged"); // case-sensitive
  });
});

describe("parseReviewEvent", () => {
  it("accepts every documented event", () => {
    expect(parseReviewEvent("COMMENT")).toBe("COMMENT");
    expect(parseReviewEvent("APPROVE")).toBe("APPROVE");
    expect(parseReviewEvent("REQUEST_CHANGES")).toBe("REQUEST_CHANGES");
  });

  it("defaults to 'COMMENT' on undefined", () => {
    expect(parseReviewEvent(undefined)).toBe("COMMENT");
  });

  it("defaults to 'COMMENT' on unknown input", () => {
    expect(parseReviewEvent("bogus")).toBe("COMMENT");
    expect(parseReviewEvent("")).toBe("COMMENT");
    expect(parseReviewEvent("comment")).toBe("COMMENT"); // case-sensitive
  });
});

describe("parseGhPr", () => {
  it("parses a valid PR JSON envelope", () => {
    const raw = JSON.stringify({
      number: 123,
      title: "feat: thing",
      body: "body",
      state: "OPEN",
      url: "https://github.com/x/y/pull/123",
      baseRefName: "main",
      headRefName: "feat/thing",
      isDraft: false,
    });
    const pr = parseGhPr(raw);
    expect(pr).not.toBeNull();
    expect(pr?.number).toBe(123);
    expect(pr?.url).toBe("https://github.com/x/y/pull/123");
  });

  it("returns null on invalid JSON", () => {
    expect(parseGhPr("not json")).toBeNull();
  });

  it("returns null on non-object root", () => {
    expect(parseGhPr("[]")).toBeNull();
    expect(parseGhPr("null")).toBeNull();
    expect(parseGhPr("42")).toBeNull();
    expect(parseGhPr('"hi"')).toBeNull();
  });

  it("returns null when minimum keys are missing or wrong type", () => {
    expect(parseGhPr("{}")).toBeNull();
    expect(parseGhPr(JSON.stringify({ number: "not a number", url: "x" }))).toBeNull();
    expect(parseGhPr(JSON.stringify({ number: 1 }))).toBeNull(); // missing url
  });
});

describe("parseGhFiles", () => {
  it("returns the files array on a valid envelope", () => {
    const raw = JSON.stringify({
      files: [
        { path: "src/a.ts", additions: 1, deletions: 0 },
        { path: "src/b.ts", additions: 0, deletions: 2 },
      ],
    });
    const files = parseGhFiles(raw);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("src/a.ts");
  });

  it("returns an empty array when files is missing", () => {
    expect(parseGhFiles("{}")).toEqual([]);
  });

  it("returns an empty array on invalid JSON", () => {
    expect(parseGhFiles("garbage")).toEqual([]);
  });

  it("returns an empty array on non-object root", () => {
    expect(parseGhFiles("null")).toEqual([]);
    expect(parseGhFiles("[]")).toEqual([]);
  });

  it("returns an empty array when files is not an array", () => {
    expect(parseGhFiles(JSON.stringify({ files: "oops" }))).toEqual([]);
  });
});

describe("parseGitLog", () => {
  // Control chars matching the `git log --format` output: 0x01 between
  // fields, 0x00 between records. Built explicitly so the tests do not
  // depend on a real git invocation.
  const F = "\u0001";
  const R = "\u0000";

  it("parses a single commit with an empty body", () => {
    const stdout = `abc123${F}2026-01-01${F}Alice${F}feat: x${F}${R}`;
    const entries = parseGitLog(stdout);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      hash: "abc123",
      isoDate: "2026-01-01",
      author: "Alice",
      subject: "feat: x",
      body: "",
    });
  });

  it("keeps a multi-paragraph body as ONE entry (regression: split on newline)", () => {
    // Before the NUL-record fix, the three body lines became three phantom
    // entries whose hash was the body text and whose date/author/subject
    // were undefined. This pins one record == one commit.
    const body = "Para one.\n\nPara two.\n\nPara three.";
    const stdout = `deadbee${F}2026-02-02${F}Bob${F}fix: y${F}${body}${R}`;
    const entries = parseGitLog(stdout);
    expect(entries).toHaveLength(1);
    expect(entries[0].hash).toBe("deadbee");
    expect(entries[0].subject).toBe("fix: y");
    expect(entries[0].body).toBe(body);
  });

  it("parses multiple commits, with and without a body", () => {
    const stdout = `h1${F}d1${F}A1${F}s1${F}body one${R}h2${F}d2${F}A2${F}s2${F}${R}`;
    const entries = parseGitLog(stdout);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ hash: "h1", body: "body one" });
    expect(entries[1]).toMatchObject({ hash: "h2", body: "" });
  });

  it("returns [] on empty stdout", () => {
    expect(parseGitLog("")).toEqual([]);
  });

  it("does not emit a phantom entry for the trailing record separator", () => {
    const stdout = `h1${F}d1${F}A1${F}s1${F}${R}${R}`;
    expect(parseGitLog(stdout)).toHaveLength(1);
  });
});
