// Unit tests for the shared `repo` param parser (lib/repo-target.ts).
// Pure string in/out: no child_process, no gate.

import { describe, expect, it } from "vitest";
import { normalizeRepoSlug, parseRepoParam, REPO_CWD_CONFLICT } from "../lib/repo-target";

describe("normalizeRepoSlug", () => {
  const ok = (input: string, expected: string) => {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(normalizeRepoSlug(input)).toBe(expected);
    });
  };
  const bad = (input: string) => {
    it(`${JSON.stringify(input)} -> null`, () => {
      expect(normalizeRepoSlug(input)).toBeNull();
    });
  };

  // Bare slugs.
  ok("foo/bar", "foo/bar");
  ok("  foo/bar  ", "foo/bar");
  ok("o-r_1/n.a-m_e2", "o-r_1/n.a-m_e2");
  ok("foo/bar.git", "foo/bar");

  // https URLs, with paste artifacts (.git, trailing paths, slash).
  ok("https://github.com/foo/bar", "foo/bar");
  ok("https://github.com/foo/bar.git", "foo/bar");
  ok("https://github.com/foo/bar/issues/12", "foo/bar");
  ok("https://github.com/foo/bar/tree/main/src", "foo/bar");
  ok("http://github.com/foo/bar/", "foo/bar");
  ok("https://www.github.com/foo/bar", "foo/bar");

  // ssh forms.
  ok("git@github.com:foo/bar.git", "foo/bar");
  ok("ssh://git@github.com/foo/bar.git", "foo/bar");

  bad("");
  bad("   ");
  bad("justname");
  bad("foo/bar/baz");
  bad("/local/path");
  bad("https://gitlab.com/foo/bar");
  bad("https://example.com/foo/bar");
  bad("https://github.com/foo");
  // Leading-dash segments would be flag-parsed by gh as a positional arg.
  bad("https://github.com/--web/x");
  bad("https://github.com/o/-x");
});

describe("parseRepoParam", () => {
  it("unset when the param is missing or blank", () => {
    expect(parseRepoParam(undefined)).toEqual({ kind: "unset" });
    expect(parseRepoParam("   ")).toEqual({ kind: "unset" });
  });

  it("ok carries the normalized slug", () => {
    expect(parseRepoParam("https://github.com/foo/bar.git")).toEqual({ kind: "ok", slug: "foo/bar" });
  });

  it("error carries actionable guidance", () => {
    const r = parseRepoParam("not-a-repo-ref");
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("owner/name");
      expect(r.message).toContain("not-a-repo-ref");
    }
  });
});

describe("REPO_CWD_CONFLICT", () => {
  it("names both params so the agent knows which one to drop", () => {
    expect(REPO_CWD_CONFLICT).toContain("repo");
    expect(REPO_CWD_CONFLICT).toContain("cwd");
    expect(REPO_CWD_CONFLICT).toContain("not both");
  });
});
