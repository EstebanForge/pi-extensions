// Concrete git/gh response shapes, shared across tool and client files.
//
// git log entries and gh JSON are the two formats we consume. The shapes
// here are the minimal projection we actually use; full fidelity is not
// needed and would only inflate the agent's context window.

// -------------------------------------------------- git log ----------------

// Subset of `git log --format=...` we render for the agent. We keep the raw
// commit hash, ISO timestamp, author, subject, and body so the LLM can choose
// what to surface without us stripping context.
export interface GitLogEntry {
  hash: string;
  isoDate: string;
  author: string;
  subject: string;
  body: string;
}

// -------------------------------------------------- gh JSON ----------------

// `gh pr view --json ...` subset. We only request the fields we actually
// consume so the agent's context stays bounded.
export interface GhPullRequest {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  url: string;
  baseRefName: string;
  headRefName: string;
  isDraft: boolean;
  author?: { login: string };
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
}

// `gh pr view --json files` subset: one entry per changed file in the PR.
export interface GhPullRequestFile {
  path: string;
  additions: number;
  deletions: number;
  // `patch` may be huge; we cap it on read.
  patch?: string;
}

