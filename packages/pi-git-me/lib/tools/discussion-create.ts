import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { describeTitleBodyPayload, repoContextLabel, toTitleBodyPrefill, fromTitleBodyPrefill } from "../format";
import {
  ghRepoView,
  ghGraphql,
  GhGraphqlError,
  DISCUSSION_CATEGORIES_QUERY,
  CREATE_DISCUSSION_MUTATION,
  parseDiscussionCategories,
} from "../github";
import { toToolResult, errorText, postedContentExtras, type GitDetails } from "../result";
import {
  DISCUSSION_CREATE_TITLE,
  DISCUSSION_CREATE_DESCRIPTION,
  DISCUSSION_CREATE_TITLE_DESCRIPTION,
  DISCUSSION_CREATE_BODY_DESCRIPTION,
  DISCUSSION_CREATE_CATEGORY_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

// Start a new GitHub Discussion. There is no `gh discussion` CLI command, so
// this goes through the GraphQL API via `gh api graphql`: resolve the repo
// (`gh repo view`), resolve the category NAME to its id (categories are
// GraphQL-only), gate the title + body, then run the createDiscussion
// mutation. Category resolution happens BEFORE the gate so a bad category
// name fails fast with the valid names listed — no dialog for a doomed write.

const Params = Type.Object({
  title: Type.String({ description: DISCUSSION_CREATE_TITLE_DESCRIPTION, minLength: 1 }),
  body: Type.String({ description: DISCUSSION_CREATE_BODY_DESCRIPTION, minLength: 1 }),
  category: Type.String({ description: DISCUSSION_CREATE_CATEGORY_DESCRIPTION, minLength: 1 }),
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

export const discussionCreateTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_discussion_create",
  label: DISCUSSION_CREATE_TITLE,
  description: DISCUSSION_CREATE_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<GitDetails>> {
    const cwd = params.cwd ?? ctx.cwd;
    try {
      requireGitRepo(cwd);
      requireGh();
    } catch (err) {
      if (err instanceof GitMeEnvError) return toToolResult(err.message);
      throw err;
    }

    try {
      const repo = ghRepoView(cwd);
      if (!repo) {
        return toToolResult(
          `git-me: could not resolve a GitHub repository for "${cwd}" (\`gh repo view\` failed). Check that the repo has a GitHub remote and that \`gh\` can see it.`,
        );
      }

      const categories = parseDiscussionCategories(
        ghGraphql(DISCUSSION_CATEGORIES_QUERY, { owner: repo.owner, name: repo.name }, cwd),
      );
      if (categories.length === 0) {
        return toToolResult(
          `git-me: ${repo.nameWithOwner} has no discussion categories. Discussions are probably disabled for this repository (repo Settings -> General -> Features -> Discussions).`,
        );
      }
      const wanted = params.category.trim().toLowerCase();
      const category = categories.find((c) => c.name.toLowerCase() === wanted);
      if (!category) {
        const names = categories.map((c) => c.name).sort().join(", ");
        return toToolResult(
          `git-me: no discussion category named "${params.category}" in ${repo.nameWithOwner}. Available categories: ${names}.`,
        );
      }

      const prefill = toTitleBodyPrefill(params.title, params.body);
      const summary = describeTitleBodyPayload(params.title, params.body);

      const decision = await confirmWrite(ctx, {
        title: `Start a new discussion in ${repo.nameWithOwner} / ${category.name} with this title + body?${repoContextLabel(cwd, ctx.cwd)}`,
        editableText: prefill,
        summary,
        normalize: (s) => {
          const r = fromTitleBodyPrefill(s, params.title);
          return `${r.title}\n${r.body}`;
        },
      });
      if (!decision.proceed) {
        return toToolResult(
          ctx.hasUI
            ? "git-me: discussion creation cancelled by user. Nothing was sent to gh."
            : "git-me: discussion not created (headless mode; no UI to review). Use /git headless on to allow unsupervised discussion creation.",
        );
      }

      const { title, body } = fromTitleBodyPrefill(decision.text ?? prefill, params.title);
      if (!title || !body) {
        return toToolResult(
          "git-me: discussion title and body are both required. Edit left one empty; nothing was created.",
        );
      }
      const postedContent = `Title: ${title}\n\n${body}`;
      const { extraText, details } = postedContentExtras(postedContent, decision.edited ?? false);

      const data = ghGraphql(
        CREATE_DISCUSSION_MUTATION,
        { repositoryId: repo.id, categoryId: category.id, title, body },
        cwd,
      );
      const discussion = (data.createDiscussion as { discussion?: { number?: number; url?: string } } | undefined)?.discussion;
      if (!discussion?.number || !discussion.url) {
        return toToolResult(
          "git-me: the createDiscussion mutation returned no discussion number/url; verify on GitHub whether it was created.",
        );
      }
      return toToolResult(
        `Created discussion #${discussion.number} in ${repo.nameWithOwner} / ${category.name}.\n  url: ${discussion.url}${extraText}`,
        details,
      );
    } catch (err) {
      if (err instanceof GhGraphqlError) return toToolResult(err.message);
      return toToolResult(errorText(err));
    }
  },
};
