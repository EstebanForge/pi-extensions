// Gate-wiring + apply-argv tests for the comment-edit tools
// (git_issue_comment_edit / git_pr_comment_edit).
//
// Same child_process mock pattern as tools.test.ts: NO test shells out to a
// real `gh`. Routes pin the exact argv the tools must produce:
//   - lookup:  `gh api repos/O/R/issues/N/comments?per_page=100 --paginate --jq '.[] | @json'`
//   - by id:   `gh api repos/O/R/issues/comments/<id>`
//   - apply:   `gh api --method PATCH repos/O/R/issues/comments/<id> -f body=<body>`
// plus the repo/login/pr-view routes the resolution needs. The gate itself is
// fully tested in confirm.test.ts; these tests pin the per-tool wiring and
// the fail-closed paths (not-mine, no-own-comment, no-op, cancel, headless).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cpMock } = vi.hoisted(() => {
  type FakeResult = { stdout: string; stderr: string; status: number };
  type Route = {
    match: (cmd: string, args: string[]) => boolean;
    result: () => FakeResult;
  };
  const state: {
    routes: Route[];
    calls: Array<{ cmd: string; args: string[] }>;
  } = { routes: [], calls: [] };
  const spawnSyncMock = (
    cmd: string,
    args: string[],
  ): FakeResult => {
    state.calls.push({ cmd, args: [...args] });
    for (const route of state.routes) {
      if (route.match(cmd, args)) return route.result();
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  const spawnStub = (): never => {
    throw new Error("tests: async spawn is not mocked");
  };
  return { cpMock: { state, spawnSyncMock, spawnStub } };
});

vi.mock("node:child_process", () => ({
  spawnSync: cpMock.spawnSyncMock,
  spawn: cpMock.spawnStub,
}));

import { _resetAuthCache } from "../lib/auth";
import { setAllowHeadlessWriteEnabled, setConfirmWriteEnabled } from "../lib/confirm";
import {
  issueCommentEditTool,
  prCommentEditTool,
} from "../lib/tools/comment-edit";
import {
  invokeWithCtx,
  makeCtx,
  makeStubUI,
  firstText,
  DEFAULT_CTX_CWD,
} from "./_helpers";

type Route = {
  match: (cmd: string, args: string[]) => boolean;
  result: () => { stdout: string; stderr: string; status: number };
};

const ROUTES: Record<string, Route> = {
  repoView: {
    match: (c, a) => c === "gh" && a[0] === "repo" && a[1] === "view",
    result: () => ({
      stdout: JSON.stringify({ id: "R_1", nameWithOwner: "octo/repo" }),
      stderr: "",
      status: 0,
    }),
  },
  login: {
    match: (c, a) => c === "gh" && a[0] === "api" && a[1] === "user",
    result: () => ({ stdout: "me\n", stderr: "", status: 0 }),
  },
  prView: {
    match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view",
    result: () => ({
      stdout: JSON.stringify({
        number: 9,
        url: "https://github.com/octo/repo/pull/9",
      }),
      stderr: "",
      status: 0,
    }),
  },
  // requireGitRepo() must pass: `git rev-parse --is-inside-work-tree` -> true.
  repoProbe: {
    match: (c, a) => c === "git" && a[0] === "rev-parse",
    result: () => ({ stdout: "true\n", stderr: "", status: 0 }),
  },
};

function routeThreadComments(lines: string[]): Route {
  return {
    match: (c, a) =>
      c === "gh" &&
      a[0] === "api" &&
      a[1]?.startsWith("repos/octo/repo/issues/") &&
      a[1]?.includes("/comments?") &&
      a.includes("--paginate"),
    result: () => ({ stdout: lines.join("\n") + "\n", stderr: "", status: 0 }),
  };
}

function routeCommentById(id: number, comment: object): Route {
  return {
    match: (c, a) =>
      c === "gh" &&
      a[0] === "api" &&
      a[1] === `repos/octo/repo/issues/comments/${id}` &&
      !a.includes("--method"),
    result: () => ({ stdout: JSON.stringify(comment), stderr: "", status: 0 }),
  };
}

// A route that RECORDS the PATCH argv and returns an updated-comment body.
// The body is captured inside match() because result() does not see the argv.
function recordingPatch(expectedId: number): {
  route: Route;
  bodies: () => string[];
} {
  const bodies: string[] = [];
  const route: Route = {
    match: (c, a) => {
      if (
        !(
          c === "gh" &&
          a[0] === "api" &&
          a[1] === "--method" &&
          a[2] === "PATCH" &&
          a[3] === `repos/octo/repo/issues/comments/${expectedId}`
        )
      )
        return false;
      const bodyArg = a.find((x) => x.startsWith("body=")) ?? "";
      bodies.push(bodyArg.slice("body=".length));
      return true;
    },
    result: () => ({
      stdout: JSON.stringify({
        id: expectedId,
        html_url: `https://github.com/octo/repo/issues/7#issuecomment-${expectedId}`,
        body: bodies[bodies.length - 1] ?? "",
        user: { login: "me" },
      }),
      stderr: "",
      status: 0,
    }),
  };
  return { route, bodies: () => bodies };
}

const MY_LAST = {
  id: 98,
  body: "old text from me",
  html_url: "https://github.com/octo/repo/issues/7#issuecomment-98",
  user: { login: "me" },
};
const THEIRS = {
  id: 97,
  body: "someone else's comment",
  user: { login: "someone-else" },
};

beforeEach(() => {
  cpMock.state.routes = [];
  cpMock.state.calls = [];
  setConfirmWriteEnabled(true);
  setAllowHeadlessWriteEnabled(false);
});

afterEach(() => {
  _resetAuthCache();
});

describe("git_issue_comment_edit", () => {
  it("edits the user's LAST comment by default: PATCH carries the replacement body", async () => {
    const { route: patchRoute, bodies } = recordingPatch(98);
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([
        JSON.stringify(THEIRS),
        JSON.stringify(MY_LAST),
      ]),
      patchRoute,
    ];
    const ui = makeStubUI({ editorResponse: "new text from me" });
    const result = await invokeWithCtx(
      issueCommentEditTool,
      { body: "new text from me", number: 7 },
      makeCtx(ui),
    );

    expect(firstText(result)).toContain("Edited your comment on issue #7");
    expect(firstText(result)).toContain("#issuecomment-98");
    // The gate prefilled the editor with the REPLACEMENT body.
    expect(ui.prompts[0]?.kind).toBe("editor");
    expect(ui.prompts[0]?.body).toBe("new text from me");
    expect(bodies()).toEqual(["new text from me"]);
  });

  it("fails closed when the user has no comment on the issue; nothing is sent", async () => {
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([JSON.stringify(THEIRS)]),
    ];
    const ui = makeStubUI();
    const result = await invokeWithCtx(
      issueCommentEditTool,
      { body: "x", number: 7 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("no comment by @me");
    expect(firstText(result)).toContain("git_issue_comment");
    expect(ui.prompts).toHaveLength(0);
    expect(cpMock.state.calls.some((c) => c.args.includes("PATCH"))).toBe(false);
  });

  it("edits an OLDER own comment when commentId is given", async () => {
    const older = { ...MY_LAST, id: 55, body: "old older body", user: { login: "me" } };
    const { route: patchRoute, bodies } = recordingPatch(55);
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeCommentById(55, older),
      patchRoute,
    ];
    const ui = makeStubUI({ editorResponse: "fixed body" });
    const result = await invokeWithCtx(
      issueCommentEditTool,
      { body: "fixed body", number: 7, commentId: 55 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("Edited your comment on issue #7");
    expect(bodies()).toEqual(["fixed body"]);
  });

  it("refuses to edit someone else's comment", async () => {
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeCommentById(97, THEIRS),
    ];
    const ui = makeStubUI({ editorResponse: "x" });
    const result = await invokeWithCtx(
      issueCommentEditTool,
      { body: "x", number: 7, commentId: 97 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("authored by @someone-else");
    expect(ui.prompts).toHaveLength(0);
  });

  it("skips the call entirely when the new body is identical", async () => {
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([JSON.stringify(MY_LAST)]),
    ];
    const ui = makeStubUI();
    const result = await invokeWithCtx(
      issueCommentEditTool,
      { body: "old text from me", number: 7 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("identical");
    expect(ui.prompts).toHaveLength(0);
    expect(cpMock.state.calls.some((c) => c.args.includes("PATCH"))).toBe(false);
  });

  it("sends nothing when the user cancels at the gate", async () => {
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([JSON.stringify(MY_LAST)]),
    ];
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      issueCommentEditTool,
      { body: "new", number: 7 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("cancelled by user");
    expect(cpMock.state.calls.some((c) => c.args.includes("PATCH"))).toBe(false);
  });

  it("refuses in headless mode by default", async () => {
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([JSON.stringify(MY_LAST)]),
    ];
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      issueCommentEditTool,
      { body: "new", number: 7 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("headless");
    expect(cpMock.state.calls.some((c) => c.args.includes("PATCH"))).toBe(false);
  });

  it("keeps the exact -f body=<body> apply argv (no shell interpolation surface)", async () => {
    const { route: patchRoute } = recordingPatch(98);
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([JSON.stringify(MY_LAST)]),
      patchRoute,
    ];
    const ui = makeStubUI({ editorResponse: "line1\nline2 --flag 'quoted'" });
    await invokeWithCtx(
      issueCommentEditTool,
      { body: "line1\nline2 --flag 'quoted'", number: 7 },
      makeCtx(ui),
    );
    const patch = cpMock.state.calls.find((c) => c.args.includes("PATCH"));
    expect(patch?.args.slice(0, 4)).toEqual([
      "api",
      "--method",
      "PATCH",
      "repos/octo/repo/issues/comments/98",
    ]);
    expect(patch?.args.slice(4)).toEqual(["-f", "body=line1\nline2 --flag 'quoted'"]);
  });
});

describe("git_pr_comment_edit", () => {
  it("honors an explicit pr param instead of the current-branch PR", async () => {
    const { route: patchRoute, bodies } = recordingPatch(98);
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([JSON.stringify(MY_LAST)]),
      patchRoute,
    ];
    const ui = makeStubUI({ editorResponse: "fix" });
    // No `pr view` route: if the tool ignored the explicit pr param and fell
    // back to the current branch, the lookup would miss and fail closed.
    const result = await invokeWithCtx(
      prCommentEditTool,
      { body: "fix", pr: 9 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("Edited your comment on PR #9");
    const list = cpMock.state.calls.find((c) => c.args.includes("--paginate"));
    expect(list?.args[1]).toBe("repos/octo/repo/issues/9/comments?per_page=100");
    expect(bodies()).toEqual(["fix"]);
  });

  it("edits by commentId even when the current branch has no PR", async () => {
    const withThread = {
      ...MY_LAST,
      id: 55,
      body: "old older body",
      issue_url: "https://github.com/octo/repo/issues/9",
    };
    const { route: patchRoute, bodies } = recordingPatch(55);
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeCommentById(55, withThread),
      patchRoute,
    ];
    const ui = makeStubUI({ editorResponse: "fixed" });
    // No `pr view` route on purpose: the commentId path must not require one.
    const result = await invokeWithCtx(
      prCommentEditTool,
      { body: "fixed", commentId: 55 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("Edited your comment on PR #9");
    expect(bodies()).toEqual(["fixed"]);
  });

  it("resolves the PR from the current branch when pr is omitted", async () => {
    const { route: patchRoute, bodies } = recordingPatch(98);
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      ROUTES.prView,
      routeThreadComments([JSON.stringify(MY_LAST)]),
      patchRoute,
    ];
    const ui = makeStubUI({ editorResponse: "pr fix" });
    const result = await invokeWithCtx(
      prCommentEditTool,
      { body: "pr fix" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("Edited your comment on PR #9");
    expect(bodies()).toEqual(["pr fix"]);
    // The thread listing used the resolved PR number.
    const list = cpMock.state.calls.find(
      (c) => c.args.includes("--paginate"),
    );
    expect(list?.args[1]).toBe("repos/octo/repo/issues/9/comments?per_page=100");
  });

  it("passes the url line from the resolved PR when the PATCH response omits one", async () => {
    const route: Route = {
      match: (c, a) =>
        c === "gh" && a[0] === "api" && a[1] === "--method" && a[2] === "PATCH",
      result: () => ({ stdout: "{}", stderr: "", status: 0 }),
    };
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      ROUTES.prView,
      routeThreadComments([JSON.stringify(MY_LAST)]),
      route,
    ];
    const ui = makeStubUI({ editorResponse: "x" });
    const result = await invokeWithCtx(
      prCommentEditTool,
      { body: "x" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("https://github.com/octo/repo/pull/9");
  });
});

describe("comment-edit env guards", () => {
  it("reports a missing repo before touching gh", async () => {
    cpMock.state.routes = [
      {
        match: (c) => c === "git",
        result: () => ({ stdout: "false", stderr: "", status: 1 }),
      },
    ];
    const ui = makeStubUI();
    const result = await invokeWithCtx(
      issueCommentEditTool,
      { body: "x", number: 7, cwd: "/not/a/repo" },
      makeCtx(ui, { cwd: DEFAULT_CTX_CWD }),
    );
    expect(firstText(result)).toContain("not inside a git working tree");
    expect(ui.prompts).toHaveLength(0);
  });
});

describe("comment-edit hardening", () => {
  it("refuses a commentId that lives on another thread", async () => {
    const onIssue9 = {
      ...MY_LAST,
      id: 55,
      issue_url: "https://github.com/octo/repo/issues/9",
    };
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeCommentById(55, onIssue9),
    ];
    const ui = makeStubUI({ editorResponse: "x" });
    const result = await invokeWithCtx(
      issueCommentEditTool,
      { body: "x", number: 7, commentId: 55 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("belongs to");
    expect(firstText(result)).toContain("issues/9");
    expect(ui.prompts).toHaveLength(0);
    expect(cpMock.state.calls.some((c) => c.args.includes("PATCH"))).toBe(false);
  });

  it("picks the chronologically LAST own comment across the paginated stream", async () => {
    const olderMine = { ...MY_LAST, id: 90, body: "older own" };
    const { route: patchRoute } = recordingPatch(98);
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([
        JSON.stringify(THEIRS),
        JSON.stringify(olderMine),
        JSON.stringify(MY_LAST),
      ]),
      patchRoute,
    ];
    const ui = makeStubUI({ editorResponse: "newest" });
    await invokeWithCtx(
      issueCommentEditTool,
      { body: "newest", number: 7 },
      makeCtx(ui),
    );
    const patch = cpMock.state.calls.find((c) => c.args.includes("PATCH"));
    expect(patch?.args[3]).toBe("repos/octo/repo/issues/comments/98");
  });

  it("refuses an empty body after the editor wipes the draft", async () => {
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([JSON.stringify(MY_LAST)]),
    ];
    const ui = makeStubUI({ editorResponse: "   " });
    const result = await invokeWithCtx(
      issueCommentEditTool,
      { body: "non-empty draft", number: 7 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("edited body is empty");
    expect(cpMock.state.calls.some((c) => c.args.includes("PATCH"))).toBe(false);
  });

  it("surfaces a PATCH failure with the gh stderr detail", async () => {
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([JSON.stringify(MY_LAST)]),
      {
        match: (c, a) =>
          c === "gh" && a[0] === "api" && a[1] === "--method" && a[2] === "PATCH",
        result: () => ({ stdout: "", stderr: "gh: API error (422)", status: 1 }),
      },
    ];
    const ui = makeStubUI({ editorResponse: "new" });
    const result = await invokeWithCtx(
      issueCommentEditTool,
      { body: "new", number: 7 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("`gh api PATCH` failed");
    expect(firstText(result)).toContain("422");
  });

  it("attaches postedContent details only when the human edited the draft", async () => {
    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([JSON.stringify(MY_LAST)]),
    ];
    const editedUi = makeStubUI({ editorResponse: "human-touched text" });
    const { route: patchRoute } = recordingPatch(98);
    cpMock.state.routes.push(patchRoute);
    const edited = await invokeWithCtx(
      issueCommentEditTool,
      { body: "agent draft", number: 7 },
      makeCtx(editedUi),
    );
    expect(edited.details).toMatchObject({ postedContent: "human-touched text", edited: true });

    cpMock.state.routes = [
      ROUTES.repoProbe,
      ROUTES.repoView,
      ROUTES.login,
      routeThreadComments([JSON.stringify(MY_LAST)]),
      recordingPatch(98).route,
    ];
    const verbatimUi = makeStubUI({ editorResponse: "verbatim draft" });
    const verbatim = await invokeWithCtx(
      issueCommentEditTool,
      { body: "verbatim draft", number: 7 },
      makeCtx(verbatimUi),
    );
    expect(verbatim.details).toBeUndefined();
  });
});
