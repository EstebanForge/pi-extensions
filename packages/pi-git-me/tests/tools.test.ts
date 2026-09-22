// Gate-wiring + apply-argv tests for the write tools.
//
// `node:child_process` is mocked so NO test shells out to real `git` / `gh`.
// The old suite was environment-dependent (it failed on a machine with an
// open PR for the cwd branch, and ran `gh auth status` ~12 times) and ran in
// the `prepublishOnly` hook. Each test now sets up spawnSync routes for the
// commands the tool will run, and the mock records every call so tests
// assert on the exact argv handed to git / gh (e.g. APPROVE -> `--approve`,
// `gh pr edit <number>` is number-addressed). The gate itself is fully
// tested in confirm.test.ts; these tests pin the per-tool wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- child_process mock -----------------------------------------------------
// vi.hoisted runs before the imports below, so the mock is in place when the
// tool modules import spawnSync. Routes return spawnSync's real shape
// ({ stdout, stderr, status }) because spawnChecked maps status -> exitCode.
const { cpMock } = vi.hoisted(() => {
  type FakeResult = { stdout: string; stderr: string; status: number };
  type Route = {
    match: (cmd: string, args: string[]) => boolean;
    result: () => FakeResult;
  };
  const state: {
    routes: Route[];
    // cwd is the options.cwd spawnSync was called with (3rd arg). Undefined
    // when the caller let it default. Lets tests assert cwd routing.
    calls: Array<{ cmd: string; args: string[]; cwd?: string }>;
  } = { routes: [], calls: [] };
  const spawnSyncMock = (
    cmd: string,
    args: string[],
    opts?: { cwd?: string },
  ): FakeResult => {
    state.calls.push({ cmd, args: [...args], cwd: opts?.cwd });
    for (const route of state.routes) {
      if (route.match(cmd, args)) return route.result();
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  // `spawn` (async, used only by the commit apply path) is stubbed to throw
  // so a test that forgets to cancel at the gate fails loudly instead of
  // hanging on a real process.
  const spawnStub = (): never => {
    throw new Error("tests: async spawn is not mocked (commit apply path is not covered here)");
  };
  return { cpMock: { state, spawnSyncMock, spawnStub } };
});

vi.mock("node:child_process", () => ({
  spawnSync: cpMock.spawnSyncMock,
  spawn: cpMock.spawnStub,
}));

import { _resetAuthCache } from "../lib/auth";
import { commitTool } from "../lib/tools/commit";
import { prUpsertTool } from "../lib/tools/pr-upsert";
import { prCommentTool } from "../lib/tools/pr-comment";
import { issueCommentTool } from "../lib/tools/issue-comment";
import { issueCreateTool } from "../lib/tools/issue-create";
import { discussionCreateTool } from "../lib/tools/discussion-create";
import { discussionCommentTool } from "../lib/tools/discussion-comment";
import { prReviewTool } from "../lib/tools/pr-review";
import { statusTool } from "../lib/tools/status";
import { diffTool } from "../lib/tools/diff";
import { logTool } from "../lib/tools/log";
import { currentBranchTool } from "../lib/tools/current-branch";
import { prInfoTool } from "../lib/tools/pr-info";
import {
  setConfirmWriteEnabled,
  setAllowHeadlessWriteEnabled,
} from "../lib/confirm";
import { invokeWithCtx, makeCtx, makeStubUI, firstText, DEFAULT_CTX_CWD } from "./_helpers";

type FakeResult = { stdout: string; stderr: string; status: number };
type Route = { match: (c: string, a: string[]) => boolean; result: () => FakeResult };
type RecordedCall = { cmd: string; args: string[]; cwd?: string };

// Default routes: a repo is present, gh is installed and authed, something is
// staged (so non-amend commits reach the gate), and the current branch has no
// PR. Tests override or extend these per case.
const DEFAULT_ROUTES: Route[] = [
  { match: (c, a) => c === "git" && a[0] === "rev-parse" && a.includes("--is-inside-work-tree"), result: () => ({ stdout: "true", stderr: "", status: 0 }) },
  // MERGE_HEAD probe (commit pre-flight): default answer is "no merge in
  // progress"; tests that need a merge override this route.
  { match: (c, a) => c === "git" && a[0] === "rev-parse" && a.includes("MERGE_HEAD"), result: () => ({ stdout: "", stderr: "", status: 1 }) },
  { match: (c, a) => c === "gh" && a[0] === "--version", result: () => ({ stdout: "gh version 2.40.0", stderr: "", status: 0 }) },
  { match: (c, a) => c === "gh" && a[0] === "auth" && a[1] === "status", result: () => ({ stdout: "", stderr: "", status: 0 }) },
  { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("--cached") && a.includes("--quiet"), result: () => ({ stdout: "", stderr: "", status: 1 }) },
  { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view", result: () => ({ stdout: "", stderr: "no pull requests found", status: 1 }) },
];

function setupRoutes(extra: Route[] = []): void {
  // Extra routes take PRECEDENCE over defaults so a test can override e.g. the
  // `gh pr view` (no-PR) default with a real PR envelope.
  cpMock.state.routes = [...extra, ...DEFAULT_ROUTES];
  cpMock.state.calls = [];
}

function findCall(cmd: string, prefix: string[]): RecordedCall | undefined {
  return cpMock.state.calls.find(
    (c) => c.cmd === cmd && c.args.slice(0, prefix.length).join(" ") === prefix.join(" "),
  );
}

// --- GitHub GraphQL / repo-view routes (discussions + issue creation) ------
// `gh repo view --json id,nameWithOwner` answers every discussion lookup.
const REPO_VIEW_ROUTE: Route = {
  match: (c, a) => c === "gh" && a[0] === "repo" && a[1] === "view",
  result: () => ({ stdout: JSON.stringify({ id: "REPOID", nameWithOwner: "octo/repo" }), stderr: "", status: 0 }),
};

// A `gh api graphql` route keyed by a query-text marker: the tools pass the
// whole document as one `-f query=...` arg, so marker-in-query is the
// deterministic dispatcher ("createDiscussion", "discussionCategories", ...).
function graphqlRoute(queryMarker: string, data: unknown): Route {
  return {
    match: (c, a) =>
      c === "gh" && a[0] === "api" && a[1] === "graphql" &&
      a.some((arg) => arg.startsWith("query=") && arg.includes(queryMarker)),
    result: () => ({ stdout: JSON.stringify({ data }), stderr: "", status: 0 }),
  };
}

const CATEGORIES = [
  { id: "CAT-GEN", name: "General" },
  { id: "CAT-IDEA", name: "Ideas" },
];

// Find the `gh api graphql` call whose query document contains a marker
// (e.g. "createDiscussion"). findCall would return the FIRST graphql call,
// which is the lookup query, not the mutation under assertion.
function findGraphqlCall(queryMarker: string): RecordedCall | undefined {
  return cpMock.state.calls.find(
    (c) => c.cmd === "gh" && c.args[0] === "api" && c.args[1] === "graphql" &&
      c.args.some((arg) => arg.startsWith("query=") && arg.includes(queryMarker)),
  );
}

function discussionCreateRoutes(): Route[] {
  return [
    REPO_VIEW_ROUTE,
    graphqlRoute("discussionCategories", { repository: { discussionCategories: { nodes: CATEGORIES } } }),
    graphqlRoute("createDiscussion", { createDiscussion: { discussion: { number: 5, url: "https://github.com/octo/repo/discussions/5" } } }),
  ];
}

function discussionCommentRoutes(): Route[] {
  return [
    REPO_VIEW_ROUTE,
    graphqlRoute("discussion(number:", { repository: { discussion: { id: "DISC1", title: "How to X", url: "https://github.com/octo/repo/discussions/3" } } }),
    graphqlRoute("addDiscussionComment", { addDiscussionComment: { comment: { url: "https://github.com/octo/repo/discussions/3#discussioncomment-9" } } }),
    // REST numeric-comment-id -> node_id resolution for threaded replies.
    {
      match: (c, a) => c === "gh" && a[0] === "api" && (a[1] ?? "").startsWith("repos/octo/repo/discussions/comments/"),
      result: () => ({ stdout: "NODE123\n", stderr: "", status: 0 }),
    },
  ];
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-git-me-tools-test-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  _resetAuthCache();
  setupRoutes();
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  _resetAuthCache();
});

// -------------------------------------------------- git_commit -------------

describe("git_commit - gate wiring", () => {
  it("user cancels (Esc in editor) -> 'commit cancelled by user' message", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "feat: x" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("commit cancelled by user");
    expect(firstText(result)).toContain("Nothing was committed");
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].kind).toBe("editor");
    expect(ui.prompts[0].title).toMatch(/commit/i);
  });

  it("headless + no opt-in -> headless refused message, no prompt", async () => {
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "feat: x" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("headless mode");
    expect(firstText(result)).toContain("/git headless on");
    expect(ui.prompts).toHaveLength(0);
  });

  it("user clears the message in the editor -> 'empty after edit' message", async () => {
    const ui = makeStubUI({ editorResponse: "   \n  " });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "feat: x" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("empty after edit");
    expect(firstText(result)).toContain("nothing committed");
  });

  it("non-amend with nothing staged returns 'nothing staged' BEFORE the gate", async () => {
    // Pre-flight runs before the editor opens: exit 0 means nothing staged.
    setupRoutes([
      { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("--cached") && a.includes("--quiet"), result: () => ({ stdout: "", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "feat: x" });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "feat: x" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("nothing staged");
    expect(ui.prompts).toHaveLength(0); // gate never opened
  });
});

// -------------------------------------------------- git_pr_comment ----------

describe("git_pr_comment - gate wiring", () => {
  it("user cancels -> 'PR comment cancelled' message", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      prCommentTool,
      { body: "lgtm", pr: 42 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("PR comment cancelled");
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].title).toContain("42");
  });

  it("headless + no opt-in -> headless refused message", async () => {
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      prCommentTool,
      { body: "lgtm", pr: 42 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("headless mode");
    expect(firstText(result)).toContain("/git headless on");
  });

  it("default PR number resolution falls back to gh pr view; surfaces 'no PR' when none exists", async () => {
    // `pr` omitted -> the tool calls ghPrForCurrentBranch, which the default
    // route answers with status 1 (no PR). Deterministic: no real gh.
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      prCommentTool,
      { body: "lgtm" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("no PR found for the current branch");
    expect(ui.prompts).toHaveLength(0); // gate never fired
  });

  it("title mentions the PR number when one is supplied", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    await invokeWithCtx(
      prCommentTool,
      { body: "lgtm", pr: 123 },
      makeCtx(ui),
    );
    expect(ui.prompts[0].title).toContain("123");
  });

  it("posts `gh pr comment <number> --body <body>` on accept", async () => {
    const ui = makeStubUI({ editorResponse: "ship it" });
    const result = await invokeWithCtx(
      prCommentTool,
      { body: "ship it", pr: 42 },
      makeCtx(ui),
    );
    const call = findCall("gh", ["pr", "comment"]);
    expect(call).toBeDefined();
    expect(call!.args).toEqual(["pr", "comment", "42", "--body", "ship it"]);
    expect(firstText(result)).toContain("Posted comment on PR #42");
    // Unchanged draft: the agent already has its own text in context, so the
    // result must NOT re-echo it (no block, no details) to save tokens.
    expect(firstText(result)).not.toContain("Edited by user");
    expect(firstText(result)).not.toContain("Final content sent");
    expect(result.details).toBeUndefined();
  });

  it("edits in the dialog -> posts the edited body and reports edited=yes", async () => {
    const ui = makeStubUI({ editorResponse: "ship it (edited)" });
    const result = await invokeWithCtx(
      prCommentTool,
      { body: "ship it", pr: 42 },
      makeCtx(ui),
    );
    const call = findCall("gh", ["pr", "comment"]);
    expect(call).toBeDefined();
    // The EDITED text is what reaches gh, not the agent's original draft.
    expect(call!.args).toEqual(["pr", "comment", "42", "--body", "ship it (edited)"]);
    expect(firstText(result)).toContain("Edited by user: yes");
    expect(firstText(result)).toContain("ship it (edited)");
    expect(result.details).toMatchObject({
      postedContent: "ship it (edited)",
      edited: true,
    });
  });
});

// -------------------------------------------------- git_issue_comment ------

describe("git_issue_comment - gate wiring", () => {
  it("user cancels -> 'issue comment cancelled' message", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      issueCommentTool,
      { number: 7, body: "reproduced" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("issue comment cancelled");
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].title).toContain("7");
  });

  it("headless + no opt-in -> headless refused message", async () => {
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      issueCommentTool,
      { number: 7, body: "reproduced" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("headless mode");
    expect(ui.prompts).toHaveLength(0);
  });

  it("user clears the body in the editor -> 'empty after edit' message", async () => {
    const ui = makeStubUI({ editorResponse: " \n  " });
    const result = await invokeWithCtx(
      issueCommentTool,
      { number: 7, body: "reproduced" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("empty after edit");
    expect(firstText(result)).toContain("nothing was posted");
  });

  it("posts `gh issue comment <number> --body <body>` on accept", async () => {
    const ui = makeStubUI({ editorResponse: "triaged" });
    const result = await invokeWithCtx(
      issueCommentTool,
      { number: 7, body: "triaged" },
      makeCtx(ui),
    );
    const call = findCall("gh", ["issue", "comment"]);
    expect(call).toBeDefined();
    expect(call!.args).toEqual(["issue", "comment", "7", "--body", "triaged"]);
    expect(firstText(result)).toContain("Posted comment on issue #7");
  });
});

// -------------------------------------------------- git_issue_create ------

describe("git_issue_create - gate wiring", () => {
  it("user cancels -> 'issue creation cancelled' message", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      issueCreateTool,
      { title: "T", body: "B" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("issue creation cancelled");
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].kind).toBe("editor");
    expect(ui.prompts[0].title).toContain("Create a new issue");
  });

  it("headless + no opt-in -> headless refused message", async () => {
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      issueCreateTool,
      { title: "T", body: "B" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("headless mode");
    expect(ui.prompts).toHaveLength(0);
  });

  it("user blanks the buffer -> 'nothing was created' message", async () => {
    const ui = makeStubUI({ editorResponse: "   \n  " });
    const result = await invokeWithCtx(
      issueCreateTool,
      { title: "T", body: "B" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("nothing was created");
    // No gh call may fire after a doomed edit.
    expect(findCall("gh", ["issue", "create"])).toBeUndefined();
  });

  it("posts `gh issue create --title T --body B` on accept and echoes the URL", async () => {
    setupRoutes([
      { match: (c, a) => c === "gh" && a[0] === "issue" && a[1] === "create", result: () => ({ stdout: "https://github.com/octo/repo/issues/31\n", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "T\n\n---\n\nB" });
    const result = await invokeWithCtx(
      issueCreateTool,
      { title: "T", body: "B" },
      makeCtx(ui),
    );
    const call = findCall("gh", ["issue", "create"]);
    expect(call).toBeDefined();
    expect(call!.args).toEqual(["issue", "create", "--title", "T", "--body", "B"]);
    expect(firstText(result)).toContain("Created issue");
    expect(firstText(result)).toContain("https://github.com/octo/repo/issues/31");
  });

  it("labels and assignees become repeated flags, edits reach gh verbatim", async () => {
    setupRoutes([
      { match: (c, a) => c === "gh" && a[0] === "issue" && a[1] === "create", result: () => ({ stdout: "https://github.com/octo/repo/issues/32\n", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "T2\n\n---\n\nB2" });
    const result = await invokeWithCtx(
      issueCreateTool,
      { title: "T", body: "B", labels: ["bug", "ui"], assignees: ["@me"] },
      makeCtx(ui),
    );
    const call = findCall("gh", ["issue", "create"]);
    expect(call!.args).toEqual([
      "issue", "create", "--title", "T2", "--body", "B2",
      "--label", "bug", "--label", "ui", "--assignee", "@me",
    ]);
    // Human edited the draft -> the result reports it.
    expect(firstText(result)).toContain("Edited by user: yes");
    expect(result.details).toMatchObject({ edited: true, postedContent: "Title: T2\n\nB2" });
  });
});

// -------------------------------------------------- git_discussion_create --

describe("git_discussion_create - gate wiring", () => {
  it("user cancels -> 'discussion creation cancelled' message; dialog names repo + category", async () => {
    setupRoutes(discussionCreateRoutes());
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      discussionCreateTool,
      { title: "T", body: "B", category: "General" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("discussion creation cancelled");
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].title).toContain("octo/repo / General");
  });

  it("headless + no opt-in -> headless refused message", async () => {
    setupRoutes(discussionCreateRoutes());
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      discussionCreateTool,
      { title: "T", body: "B", category: "General" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("headless mode");
    expect(ui.prompts).toHaveLength(0);
  });

  it("unknown category fails BEFORE the gate and lists the valid names", async () => {
    setupRoutes(discussionCreateRoutes());
    const ui = makeStubUI({ editorResponse: "T\n\n---\n\nB" });
    const result = await invokeWithCtx(
      discussionCreateTool,
      { title: "T", body: "B", category: "Nope" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain('no discussion category named "Nope"');
    expect(firstText(result)).toContain("General, Ideas");
    expect(ui.prompts).toHaveLength(0); // doomed write: no dialog
  });

  it("repo with zero categories gets the Discussions-disabled hint", async () => {
    setupRoutes([
      REPO_VIEW_ROUTE,
      graphqlRoute("discussionCategories", { repository: { discussionCategories: { nodes: [] } } }),
    ]);
    const result = await invokeWithCtx(
      discussionCreateTool,
      { title: "T", body: "B", category: "General" },
      makeCtx(makeStubUI()),
    );
    expect(firstText(result)).toContain("no discussion categories");
    expect(firstText(result)).toContain("Settings");
  });

  it("accept resolves the category name (case-insensitive) to its id and runs the mutation", async () => {
    setupRoutes(discussionCreateRoutes());
    const ui = makeStubUI({ editorResponse: "T\n\n---\n\nB" });
    const result = await invokeWithCtx(
      discussionCreateTool,
      { title: "T", body: "B", category: "general" },
      makeCtx(ui),
    );
    const call = findGraphqlCall("createDiscussion");
    expect(call).toBeDefined();
    expect(call!.args).toContain("categoryId=CAT-GEN");
    expect(call!.args).toContain("repositoryId=REPOID");
    expect(call!.args).toContain("title=T");
    expect(call!.args).toContain("body=B");
    expect(firstText(result)).toContain("Created discussion #5");
    expect(firstText(result)).toContain("https://github.com/octo/repo/discussions/5");
  });

  it("gh repo view failure surfaces the actionable message, no gate", async () => {
    setupRoutes([
      { match: (c, a) => c === "gh" && a[0] === "repo" && a[1] === "view", result: () => ({ stdout: "", stderr: "no git remotes found", status: 1 }) },
    ]);
    const ui = makeStubUI();
    const result = await invokeWithCtx(
      discussionCreateTool,
      { title: "T", body: "B", category: "General" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("could not resolve a GitHub repository");
    expect(ui.prompts).toHaveLength(0);
  });

  it("graphql failure (non-zero exit) surfaces as an error, not a throw", async () => {
    setupRoutes([
      REPO_VIEW_ROUTE,
      { match: (c, a) => c === "gh" && a[0] === "api" && a[1] === "graphql", result: () => ({ stdout: "", stderr: "gh: Network down", status: 1 }) },
    ]);
    const result = await invokeWithCtx(
      discussionCreateTool,
      { title: "T", body: "B", category: "General" },
      makeCtx(makeStubUI()),
    );
    expect(firstText(result)).toContain("gh api graphql` failed");
    expect(firstText(result)).toContain("Network down");
  });
});

// -------------------------------------------------- git_discussion_comment -

describe("git_discussion_comment - gate wiring", () => {
  it("user cancels -> 'discussion comment cancelled' message; dialog names the discussion", async () => {
    setupRoutes(discussionCommentRoutes());
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      discussionCommentTool,
      { number: 3, body: "ans" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("discussion comment cancelled");
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].title).toContain('#3 "How to X"');
  });

  it("headless + no opt-in -> headless refused message", async () => {
    setupRoutes(discussionCommentRoutes());
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      discussionCommentTool,
      { number: 3, body: "ans" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("headless mode");
    expect(ui.prompts).toHaveLength(0);
  });

  it("unknown discussion number fails BEFORE the gate", async () => {
    setupRoutes([
      REPO_VIEW_ROUTE,
      graphqlRoute("discussion(number:", { repository: { discussion: null } }),
    ]);
    const ui = makeStubUI();
    const result = await invokeWithCtx(
      discussionCommentTool,
      { number: 3, body: "ans" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("no discussion #3 found");
    expect(ui.prompts).toHaveLength(0);
  });

  it("top-level comment: mutation carries discussionId and NO replyToId", async () => {
    setupRoutes(discussionCommentRoutes());
    const ui = makeStubUI({ editorResponse: "ans" });
    const result = await invokeWithCtx(
      discussionCommentTool,
      { number: 3, body: "ans" },
      makeCtx(ui),
    );
    const call = findGraphqlCall("addDiscussionComment");
    expect(call!.args).toContain("discussionId=DISC1");
    expect(call!.args).toContain("body=ans");
    // replyToId must be OMITTED entirely (empty-string ID is not null).
    expect(call!.args).not.toContain("replyToId=");
    expect(firstText(result)).toContain("Comment posted on discussion #3");
    expect(firstText(result)).toContain("#discussioncomment-9");
  });

  it("numeric replyTo resolves via REST to node_id and the mutation carries replyToId", async () => {
    setupRoutes(discussionCommentRoutes());
    const ui = makeStubUI({ editorResponse: "same here" });
    const result = await invokeWithCtx(
      discussionCommentTool,
      { number: 3, body: "same here", replyTo: "1766402" },
      makeCtx(ui),
    );
    const rest = cpMock.state.calls.find(
      (c) => c.cmd === "gh" && c.args[0] === "api" && c.args[1]?.startsWith("repos/octo/repo/discussions/comments/1766402"),
    );
    expect(rest).toBeDefined(); // numeric id went through the REST resolve
    const mutation = findGraphqlCall("addDiscussionComment");
    expect(mutation!.args).toContain("replyToId=NODE123");
    expect(firstText(result)).toContain("Reply posted on discussion #3");
  });

  it("GraphQL node-id replyTo is used as-is (no REST resolve call)", async () => {
    setupRoutes(discussionCommentRoutes());
    await invokeWithCtx(
      discussionCommentTool,
      { number: 3, body: "x", replyTo: "DICabc123" },
      makeCtx(makeStubUI({ editorResponse: "x" })),
    );
    const rest = cpMock.state.calls.find(
      (c) => c.cmd === "gh" && c.args[0] === "api" && c.args[1]?.startsWith("repos/"),
    );
    expect(rest).toBeUndefined();
    expect(findGraphqlCall("addDiscussionComment")!.args).toContain("replyToId=DICabc123");
  });

  it("unresolvable numeric replyTo fails before the gate with the comment id", async () => {
    setupRoutes([
      REPO_VIEW_ROUTE,
      graphqlRoute("discussion(number:", { repository: { discussion: { id: "DISC1", title: "How to X", url: "u" } } }),
      { match: (c, a) => c === "gh" && a[0] === "api" && (a[1] ?? "").startsWith("repos/octo/repo/discussions/comments/"), result: () => ({ stdout: "", stderr: "Not Found", status: 1 }) },
    ]);
    const ui = makeStubUI();
    const result = await invokeWithCtx(
      discussionCommentTool,
      { number: 3, body: "ans", replyTo: "999" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("comment 999 not found");
    expect(ui.prompts).toHaveLength(0);
  });
});

// -------------------------------------------------- git_pr_review -----

// APPROVE / REQUEST_CHANGES are stateful and hard to reverse, so they are
// forced through the gate (prompted even with git-confirm-write off) and
// blocked unconditionally in headless mode (the headless opt-in does NOT
// apply). COMMENT behaves like the other prose tools.
describe("git_pr_review - APPROVE / REQUEST_CHANGES are forced", () => {
  it("APPROVE opens the editor even when git-confirm-write is off", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ editorResponse: undefined }); // cancel
    const result = await invokeWithCtx(
      prReviewTool,
      { body: "lgtm", pr: 42, event: "APPROVE" },
      makeCtx(ui),
    );
    // Forced: the editor fires despite the review gate being off.
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].kind).toBe("editor");
    expect(ui.prompts[0].title).toMatch(/approve/i);
    expect(firstText(result)).toContain("cancelled");
  });

  it("REQUEST_CHANGES is also forced (editor opens with gate off)", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      prReviewTool,
      { body: "please fix x", pr: 42, event: "REQUEST_CHANGES" },
      makeCtx(ui),
    );
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].title).toMatch(/request changes/i);
    expect(firstText(result)).toContain("cancelled");
  });

  it("APPROVE is refused in headless even with git-allow-headless-write on", async () => {
    setAllowHeadlessWriteEnabled(true);
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      prReviewTool,
      { body: "lgtm", pr: 42, event: "APPROVE" },
      makeCtx(ui),
    );
    // Forced writes block headless unconditionally; the opt-in does not help.
    expect(ui.prompts).toHaveLength(0);
    expect(firstText(result)).toContain("headless");
    expect(firstText(result)).not.toContain("/git headless on");
  });

  it("APPROVE on accept posts `gh pr review <n> --approve --body <body>`", async () => {
    const ui = makeStubUI({ editorResponse: "lgtm" });
    const result = await invokeWithCtx(
      prReviewTool,
      { body: "lgtm", pr: 42, event: "APPROVE" },
      makeCtx(ui),
    );
    const call = findCall("gh", ["pr", "review"]);
    expect(call).toBeDefined();
    expect(call!.args).toEqual(["pr", "review", "42", "--approve", "--body", "lgtm"]);
    expect(firstText(result)).toContain("Approved PR #42");
  });

  it("REQUEST_CHANGES on accept posts `gh pr review <n> --request-changes --body`", async () => {
    const ui = makeStubUI({ editorResponse: "fix the leak" });
    await invokeWithCtx(
      prReviewTool,
      { body: "fix the leak", pr: 8, event: "REQUEST_CHANGES" },
      makeCtx(ui),
    );
    const call = findCall("gh", ["pr", "review"]);
    expect(call!.args).toEqual(["pr", "review", "8", "--request-changes", "--body", "fix the leak"]);
  });

  it("COMMENT (default) on accept posts `gh pr review <n> --comment --body`", async () => {
    const ui = makeStubUI({ editorResponse: "nit: typo" });
    await invokeWithCtx(
      prReviewTool,
      { body: "nit: typo", pr: 3 },
      makeCtx(ui),
    );
    const call = findCall("gh", ["pr", "review"]);
    expect(call!.args).toEqual(["pr", "review", "3", "--comment", "--body", "nit: typo"]);
  });
});

// -------------------------------------------------- git_pr_upsert -----------

describe("git_pr_upsert - create vs edit", () => {
  it("no existing PR -> dialog says 'Open a new PR' and runs `gh pr create`", async () => {
    setupRoutes([
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "create", result: () => ({ stdout: "https://github.com/o/r/pull/7\n", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "T\n\n---\n\nB" });
    const result = await invokeWithCtx(
      prUpsertTool,
      { title: "T", body: "B" },
      makeCtx(ui),
    );
    expect(ui.prompts[0].title).toContain("Open a new PR");
    const call = findCall("gh", ["pr", "create"]);
    expect(call).toBeDefined();
    expect(call!.args).toEqual(["pr", "create", "--title", "T", "--body", "B", "--base", "main"]);
    expect(firstText(result)).toContain("Opened PR");
    expect(firstText(result)).toContain("https://github.com/o/r/pull/7");
  });

  it("existing PR -> dialog says 'Overwrite PR #N' and runs `gh pr edit <number>`", async () => {
    const prJson = JSON.stringify({
      number: 99, title: "old", body: "", state: "OPEN",
      url: "https://github.com/o/r/pull/99", baseRefName: "main",
      headRefName: "feat", isDraft: false,
    });
    setupRoutes([
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view", result: () => ({ stdout: prJson, stderr: "", status: 0 }) },
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "edit", result: () => ({ stdout: "", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "T2\n\n---\n\nB2" });
    const result = await invokeWithCtx(
      prUpsertTool,
      { title: "T2", body: "B2" },
      makeCtx(ui),
    );
    expect(ui.prompts[0].title).toContain("Overwrite PR #99");
    const call = findCall("gh", ["pr", "edit"]);
    // Number-addressed, not branch-addressed: a checkout between resolve and
    // apply cannot edit the wrong PR.
    expect(call!.args).toEqual(["pr", "edit", "99", "--title", "T2", "--body", "B2"]);
    expect(firstText(result)).toContain("Updated PR #99");
  });

  it("user deletes the separator -> falls back to the agent title, still applies", async () => {
    setupRoutes([
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "create", result: () => ({ stdout: "https://github.com/o/r/pull/1\n", stderr: "", status: 0 }) },
    ]);
    // Editor returns body-only (separator deleted). fromPrefill must keep the
    // agent-supplied title instead of hard-failing after acceptance.
    const ui = makeStubUI({ editorResponse: "just a body now" });
    const result = await invokeWithCtx(
      prUpsertTool,
      { title: "AgentTitle", body: "AgentBody" },
      makeCtx(ui),
    );
    const call = findCall("gh", ["pr", "create"]);
    expect(call!.args).toEqual(["pr", "create", "--title", "AgentTitle", "--body", "just a body now", "--base", "main"]);
    expect(firstText(result)).toContain("Opened PR");
  });
});

// -------------------------------------------------- gate wiring -------------

describe("gate wiring - confirm-write off", () => {
  it("a COMMENT review SKIPS the dialog and proceeds when git-confirm-write is off", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ editorResponse: undefined }); // would cancel, but gate is off
    const result = await invokeWithCtx(
      prReviewTool,
      { body: "note", pr: 5 },
      makeCtx(ui),
    );
    expect(ui.prompts).toHaveLength(0); // gate skipped entirely
    const call = findCall("gh", ["pr", "review"]);
    expect(call!.args).toEqual(["pr", "review", "5", "--comment", "--body", "note"]);
    expect(firstText(result)).toContain("Posted review comment on PR #5");
  });

  it("APPROVE still opens the dialog when git-confirm-write is off (forced)", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ editorResponse: undefined }); // cancel
    await invokeWithCtx(
      prReviewTool,
      { body: "lgtm", pr: 5, event: "APPROVE" },
      makeCtx(ui),
    );
    expect(ui.prompts).toHaveLength(1); // forced: still prompts
  });
});

// -------------------------------------------------- amend path -------------

describe("git_commit - amend path skips the staged pre-flight", () => {
  it("amend with nothing staged still gets to the gate (no 'nothing staged' message)", async () => {
    // Default route says nothing staged (status 0) for the cached check, but
    // amend skips the pre-flight, so the gate is the only thing that runs.
    setupRoutes([
      { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("--cached") && a.includes("--quiet"), result: () => ({ stdout: "", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "fix: tweaked", amend: true },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("commit cancelled");
    expect(ui.prompts[0].title).toContain("Amend");
  });
});

// -------------------------------------------------- merge path -------------

describe("git_commit - in-progress merge skips the staged pre-flight", () => {
  const MERGE_HEAD_ROUTE: Route = {
    match: (c, a) => c === "git" && a[0] === "rev-parse" && a.includes("MERGE_HEAD"),
    result: () => ({ stdout: "", stderr: "", status: 0 }),
  };

  it("merge in progress with nothing staged reaches the gate (no 'nothing staged')", async () => {
    // `git merge --no-commit` of an already-contained branch: MERGE_HEAD
    // exists, index is clean, and the commit records pure ancestry. git
    // accepts this; the old staged-only guard rejected it and made such
    // merges unreachable through the sanctioned gate.
    setupRoutes([
      MERGE_HEAD_ROUTE,
      { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("--cached") && a.includes("--quiet"), result: () => ({ stdout: "", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "Merge branch 'feature' (ancestry marker)" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("commit cancelled");
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].title).toContain("merge");
  });

  it("no merge in progress + nothing staged still refuses BEFORE the gate", async () => {
    // Default routes answer the MERGE_HEAD probe with status 1 (no merge).
    setupRoutes([
      { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("--cached") && a.includes("--quiet"), result: () => ({ stdout: "", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "Merge branch 'x'" });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "Merge branch 'x'" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("nothing staged");
    expect(ui.prompts).toHaveLength(0); // gate never opened
  });
});

// -------------------------------------------------- cwd routing ------------
// Every tool accepts an optional `cwd` so the agent can operate on a
// different repository than the one pi was started in. The read tools are
// gate-free and uniform, so a describe.each pins BOTH directions (explicit
// cwd reaches the git/gh call; omitted cwd falls back to ctx.cwd) across all
// five. The write tools are then covered individually: preflight calls
// (gate cancelled) for commit / pr-upsert / pr-comment / pr-review, and an
// APPLY-path call (gate accepted) for issue-comment, so a future regression
// dropping `cwd` from any one runGit/runGh call site is caught.

const TARGET_CWD = "/explicit/target/repo";

const READ_CWD_CASES = [
  { name: "git_status", tool: statusTool, params: {}, cmd: "git", prefix: ["status"] },
  { name: "git_diff", tool: diffTool, params: {}, cmd: "git", prefix: ["diff"] },
  { name: "git_log", tool: logTool, params: {}, cmd: "git", prefix: ["log"] },
  { name: "git_current_branch", tool: currentBranchTool, params: {}, cmd: "git", prefix: ["symbolic-ref"] },
  { name: "git_pr_info", tool: prInfoTool, params: {}, cmd: "gh", prefix: ["pr", "view"] },
];

describe.each(READ_CWD_CASES)("cwd routing: $name", ({ tool, params, cmd, prefix }) => {
  it("passes explicit cwd to its git/gh call", async () => {
    await invokeWithCtx(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool as any,
      { ...params, cwd: TARGET_CWD } as any,
      makeCtx(makeStubUI()),
    );
    expect(findCall(cmd, prefix)?.cwd).toBe(TARGET_CWD);
  });

  it("falls back to ctx.cwd when cwd is omitted", async () => {
    await invokeWithCtx(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool as any,
      params as any,
      makeCtx(makeStubUI()),
    );
    expect(findCall(cmd, prefix)?.cwd).toBe(DEFAULT_CTX_CWD);
  });
});

describe("cwd routing: write tools", () => {
  it("git_commit: preflight (rev-parse + diff --cached) carries explicit cwd (gate cancelled)", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    await invokeWithCtx(commitTool, { subject: "feat: x", cwd: TARGET_CWD }, makeCtx(ui));
    expect(findCall("git", ["rev-parse"])?.cwd).toBe(TARGET_CWD);
    expect(findCall("git", ["diff"])?.cwd).toBe(TARGET_CWD);
  });

  it("git_pr_upsert: preflight gh pr view carries explicit cwd (gate cancelled)", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    await invokeWithCtx(prUpsertTool, { title: "t", body: "b", cwd: TARGET_CWD }, makeCtx(ui));
    expect(findCall("gh", ["pr", "view"])?.cwd).toBe(TARGET_CWD);
  });

  it("git_pr_comment: current-branch PR lookup carries explicit cwd (fails closed, no gate)", async () => {
    await invokeWithCtx(prCommentTool, { body: "b", cwd: TARGET_CWD }, makeCtx(makeStubUI()));
    expect(findCall("gh", ["pr", "view"])?.cwd).toBe(TARGET_CWD);
  });

  it("git_pr_review: current-branch PR lookup carries explicit cwd (fails closed, no gate)", async () => {
    await invokeWithCtx(prReviewTool, { body: "b", cwd: TARGET_CWD }, makeCtx(makeStubUI()));
    expect(findCall("gh", ["pr", "view"])?.cwd).toBe(TARGET_CWD);
  });

  it("git_issue_comment: apply gh issue comment carries explicit cwd (gate accepted)", async () => {
    const ui = makeStubUI({ editorResponse: "ship it" });
    await invokeWithCtx(
      issueCommentTool,
      { number: 7, body: "ship it", cwd: TARGET_CWD },
      makeCtx(ui),
    );
    expect(findCall("gh", ["issue", "comment"])?.cwd).toBe(TARGET_CWD);
  });

  it("git_issue_create: apply gh issue create carries explicit cwd (gate accepted)", async () => {
    setupRoutes([
      { match: (c, a) => c === "gh" && a[0] === "issue" && a[1] === "create", result: () => ({ stdout: "https://github.com/o/r/issues/9\n", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "T\n\n---\n\nB" });
    await invokeWithCtx(
      issueCreateTool,
      { title: "T", body: "B", cwd: TARGET_CWD },
      makeCtx(ui),
    );
    expect(findCall("gh", ["issue", "create"])?.cwd).toBe(TARGET_CWD);
  });

  it("git_discussion_comment: graphql lookup carries explicit cwd (gate cancelled)", async () => {
    setupRoutes(discussionCommentRoutes());
    await invokeWithCtx(
      discussionCommentTool,
      { number: 3, body: "ans", cwd: TARGET_CWD },
      makeCtx(makeStubUI({ editorResponse: undefined })),
    );
    expect(findCall("gh", ["repo", "view"])?.cwd).toBe(TARGET_CWD);
    expect(findCall("gh", ["api", "graphql"])?.cwd).toBe(TARGET_CWD);
  });
});
