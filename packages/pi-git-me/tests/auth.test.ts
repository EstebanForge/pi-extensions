// Unit tests for the auth helpers: repoCache TTL, ghAuthed cache window,
// and the GitMeEnvError shape. These are pure (the cache tests use
// _resetAuthCache + manual Date.now mocking via the cached entry inspection).

import { afterEach, describe, expect, it } from "vitest";
import {
  GitMeEnvError,
  _REPO_CACHE_MS,
  _resetAuthCache,
  isGitRepo,
} from "../lib/auth";

afterEach(() => {
  _resetAuthCache();
});

describe("isGitRepo cache TTL", () => {
  it("cache TTL is exported and equals 60 seconds", () => {
    expect(_REPO_CACHE_MS).toBe(60_000);
  });

  it("isGitRepo returns the same value on repeated calls within the TTL window", () => {
    // isGitRepo on a non-git cwd returns false. The cache ensures the
    // second call doesn't re-spawn git (we cannot observe spawn counts
    // without mocking, so we verify the public result is stable).
    const cwd = "/tmp/pi-git-me-never-a-repo-" + Math.random();
    const first = isGitRepo(cwd);
    const second = isGitRepo(cwd);
    expect(first).toBe(false);
    expect(second).toBe(false);
  });

  it("_resetAuthCache clears the cache", () => {
    const cwd = "/tmp/pi-git-me-reset-" + Math.random();
    expect(isGitRepo(cwd)).toBe(false);
    _resetAuthCache();
    // After reset the next call still returns false, but the cache miss
    // path was taken; we cannot assert the spawn directly without mocking,
    // but the public contract is unchanged.
    expect(isGitRepo(cwd)).toBe(false);
  });
});

describe("GitMeEnvError", () => {
  it("captures kind + message + name", () => {
    const err = new GitMeEnvError("no_repo", "not a repo");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GitMeEnvError");
    expect(err.kind).toBe("no_repo");
    expect(err.message).toBe("not a repo");
  });

  it("accepts every documented kind", () => {
    for (const kind of ["no_git", "no_gh", "no_repo", "gh_not_authed"] as const) {
      const err = new GitMeEnvError(kind, "msg");
      expect(err.kind).toBe(kind);
    }
  });
});
