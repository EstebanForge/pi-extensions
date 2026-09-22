# @estebanforge/pi-asana-me

Asana Work Graph tool for the [pi coding agent](https://pi.dev). Adds 19 LLM-callable tools (asana_*) that query the Asana REST API over plain HTTP, mirroring a curated subset of the official Asana MCP tool set &mdash; **no MCP server install required**.

## Install

```bash
pi install npm:@estebanforge/pi-asana-me
```

## What it adds

| Tool | Purpose |
| --- | --- |
| `asana_search_objects` | Keyword search across an Asana workspace (one resource type per call: task / project / user / tag) |
| `asana_get_my_tasks` | Tasks assigned to the authenticated user (workspace required) |
| `asana_get_tasks` | Filtered task list (project / section / tag / assignee) |
| `asana_get_task` | Full detail for one task (notes truncated ~2000 chars) |
| `asana_get_task_description` | Full, untruncated notes/description for one task. Use when `asana_get_task`'s truncation marker fires. |
| `asana_get_task_comments` | Most-recent human comments on a task (default: last 5, max 50). On-demand. |
| `asana_get_comment` | Full, untruncated text of one comment (story). Use when `asana_get_task_comments`'s 700-char truncation marker fires. |
| `asana_list_attachments` | List files + inline images attached to a task (metadata only; no binary). |
| `asana_download_attachment` | Download one attachment to a local file, return the path. Asana-hosted files write to disk; external hosts (Drive/Dropbox/...) return a view_url. |
| `asana_get_project` | Full detail for one project (sections optional) |
| `asana_get_projects` | List projects in a workspace or team |
| `asana_get_status_overview` | Aggregated status report across projects |
| `asana_get_me` | Who am I in Asana + my workspaces |
| `asana_create_tasks` | Create up to 50 tasks in a single call. Write. |
| `asana_update_tasks` | Update up to 50 tasks in a single call. Write. |
| `asana_add_comment` | Add a text or HTML comment to a task; attach local images with `images`. Write. |
| `asana_update_comment` | Edit the text of a comment previously posted (own comments only). Write. |
| `asana_get_custom_fields` | Read every custom field on a task: name, type (text/number/enum), enum options, current value, gid. Read. |
| `asana_set_custom_fields` | Set custom fields by name (enum options resolve to gids; text/number coerced; null clears). Write. |

Compact tool guidance is injected via the `before_agent_start` hook (no skill file, to keep token cost minimal). A `/asana <verb> [args]` slash command pins intent for direct invocation.

## How it works

Asana publishes an MCP server (`https://mcp.asana.com/v2/mcp`) for AI clients, but MCP tokens are workspace-scoped and **do not work with the Asana REST API** &mdash; they are only valid against the MCP server. This extension calls the Asana REST API directly (`https://app.asana.com/api/1.0/`) with a personal access token, so the same API surface Asana documents publicly is available inside pi without requiring you to register an MCP app, configure OAuth, or install an MCP adapter.

## Configuration

This extension reads **only** the `ASANA_ACCESS_TOKEN` environment variable. No file fallback, no other env vars, no config file, no keyring integration.

```bash
export ASANA_ACCESS_TOKEN="2/12345/67890:abcdef..."
```

Create a personal access token at <https://app.asana.com/0/my-apps> &rarr; **Create personal access token**. The token grants the same access your Asana user account has &mdash; no extra scopes to set.

If the environment variable is missing, every tool returns a single error message pointing to this section.

### Write review gate (default on)

The five write tools (`asana_add_comment`, `asana_update_comment`, `asana_create_tasks`, `asana_update_tasks`, `asana_set_custom_fields`) prompt you for review before posting:

- **Comments** open in an editable preview &mdash; trim the model's prose, then accept (Enter) or cancel (Esc). The posted text is whatever you leave in the editor. The dialog title shows the target task's **name and Asana URL**, not just its GID.
- **Task batches** show a readable summary and ask yes/no. Each task (and its `parent`, where set) renders as `'Name' (url)` when resolvable.
- **Custom fields** (`asana_set_custom_fields`) show a yes/no summary with the task's **name and Asana URL** at the top, then each field as `name = value`. Enum values render by option name, `null` as `(clear)`. If any field can't be resolved before the dialog (unknown name, invalid enum option, unsupported type such as date/people/multi_enum, ambiguous name), the whole batch is refused with a per-field reason and nothing is written.
- Summaries resolve GIDs to names + URLs best-effort; any GID that can't be resolved falls back to `gid: <gid>`, so nothing ever blocks on a lookup miss.
- In **headless** sessions (no interactive UI) the gate is skipped so unsupervised runs never deadlock, and no extra lookups are issued.

Toggle it:

| Command | Effect |
| --- | --- |
| `/asana config` | Settings modal (TUI) to toggle the gate; status line elsewhere. |
| `/asana confirm on` / `/asana confirm off` | One-shot toggle. |

The value is persisted in `<piDir>/pi-asana-me.json` (`{ "confirmWrite": bool }`), where `<piDir>` is `process.env.PI_CODING_AGENT_DIR || ~/.pi/agent`. The `asana-confirm-write` flag is also registered for `/settings` visibility and the `--asana-confirm-write` CLI override, but the gate reads the JSON file.

## Usage

You do not need to mention Asana. The agent reaches for these tools whenever a request touches Asana data:

```
What tasks do I have assigned this week?
```

```
Find the Wicket project in my workspace and list its incomplete tasks.
```

```
Show me the details of task 1234567890123456.
```

```
Create a task in the Bugs project: "Investigate flaky test",
  due Friday, assign it to me.
```

```
Mark task 1234567890123456 as complete.
```

Slash command (pinned intent): `/asana <verb>` prefills the editor with an explicit ask. Hit Enter to run.

| Invocation | Maps to |
| --- | --- |
| `/asana me` | asana_get_me |
| `/asana my` / `/asana my incomplete` / `/asana my completed` | asana_get_my_tasks |
| `/asana show <gid>` | asana_get_task |
| `/asana project <gid>` | asana_get_project |
| `/asana search <workspace> <query>` | asana_search_objects (defaults to resource_type=task) |
| `/asana status <gid>...` | asana_get_status_overview |
| `/asana comments <gid> [N]` | asana_get_task_comments (last N comments; default 5) |
| `/asana comment <gid>` | asana_get_comment (full text of one comment) |
| `/asana attachments <gid>` | asana_list_attachments (files + inline images on a task) |
| `/asana download <gid>` | asana_download_attachment (fetch one attachment to disk) |
| `/asana create <text>` | asana_create_tasks |
| `/asana config` | Toggle the write review gate (settings modal in TUI) |
| `/asana confirm on\|off` | Toggle the write review gate (one-shot) |

Bare `/asana` prints a usage reminder.

## Tool selection guidance

Reach for them in this order:

1. `asana_search_objects` &mdash; when you do not know a GID.
2. `asana_get_me` &mdash; identity + workspace membership lookup.
3. `asana_get_my_tasks` &mdash; shortcut for "what is on my plate".
4. `asana_get_tasks` / `asana_get_project(s)` &mdash; bulk read scoped to a project / section / tag / assignee.
5. `asana_get_task` &mdash; full detail on one task.
6. `asana_get_task_description` &mdash; the full, untruncated task notes/description. `asana_get_task` truncates notes to 2000 chars and prints a marker; reach for this when you need the whole body (acceptance criteria, background, implementation notes).
7. `asana_get_status_overview` &mdash; aggregated status report (do not chain a search before it).
8. `asana_get_task_comments` &mdash; clarifications and reviewer threads live in comments, not in `notes`. Pull on demand when the task context is a conversation, not a record. Each comment truncates at 700 chars; the footer names the `story_gid` to pass to `asana_get_comment`.
9. `asana_get_comment` &mdash; the full, untruncated body of a single comment. Reach for it when a comment's truncation marker fired and that comment is the work (a decision, a Q&A, a spec).
10. `asana_list_attachments` &mdash; files uploaded to a task AND images pasted inline into comments both live here. Call it whenever a task or comment references an attached file/image, to discover the `attachment_gid` for the next step.
11. `asana_download_attachment` &mdash; fetch one attachment's bytes to a local file (returns the path). Run the `read` tool on the path to view an image, or parse a csv/xls/json from disk. External hosts (Drive/Dropbox/Box/OneDrive) return a `view_url` instead of a file.
12. Write tools (`create_tasks`, `update_tasks`, `add_comment`, `update_comment`) &mdash; only after you have the IDs. The extension shows the drafted payload for accept/edit/cancel; you do not need to ask the user first.

## Notes

- These tools make real calls against your Asana workspace. Write tools (`create_tasks`, `update_tasks`, `add_comment`, `update_comment`) prompt you for review before posting when the write review gate is on (default); see [Configuration](#configuration).
- The typeahead endpoint (`asana_search_objects`) accepts only ONE resource type per call (single enum `task` / `project` / `user` / `tag`); it does not accept a CSV. Call the tool once per type to fan out across types.
- The `/tasks` endpoint requires either project/section/tag, OR (assignee AND workspace). `asana_get_my_tasks` enforces this by making `workspace` a required parameter.
- Asana enforces rate limits (~150 req/min per PAT). A 429 response surfaces a clear retry message.
- Downloaded attachments land in a per-process temp dir under `os.tmpdir()` (`/tmp` on Linux, the per-user sandbox temp on macOS, `%TEMP%` on Windows) that is wiped when the pi session ends, so files never accumulate and no cleanup routine is needed. Pass `output_dir` to `asana_download_attachment` only when you want to keep a file beyond the session; a caller-supplied dir is caller-owned and not auto-cleaned.
- The 16-tool surface omits several official MCP tools that did not age well in an LLM agent context: interactive `*_preview` tools (Claude/ChatGPT-only confirmation UI), `search_tasks` (Premium-only; overlaps `search_objects`), `get_portfolio*` (niche), `get_agent*` (AI Teammates only), and `delete_task` (destructive &mdash; add on request). Attachments ARE supported, split into a metadata list (`asana_list_attachments`) and an on-demand disk download (`asana_download_attachment`) instead of the MCP server's binary-blob `get_attachments`.
- Do not pass secrets or PII in `notes` or `text` arguments to write tools &mdash; they land in your Asana workspace directly.

## Comment formatting (HTML &amp; mentions)

`asana_add_comment` sends plain text by default. Set `html: true` to send Asana [`html_text`](https://developers.asana.com/docs/rich-text) when you need an @-mention or inline formatting. Plain text is almost always the right choice; reach for HTML only for mentions or bold/italic/code/lists.

**The footgun.** Asana does **not** reject malformed `html_text`. The request returns HTTP 201, but the comment is stored as literal plain text with every tag visible (`<body>`, `<a ...>`, the lot). One unsupported tag, or one unresolvable mention, poisons the whole comment with no error signal. ([Forum corroboration](https://forum.asana.com/t/adding-richtext-story-results-in-comment-with-html-code-still-in-it-if-paragraph-tags-are-used/60593).)

This extension guards against that: when `html: true`, the tool validates the body and **refuses to post** if it would trigger the fallback, returning the exact reason.

**Rules when `html: true`:**

| | |
| --- | --- |
| Wrapper | The entire body MUST be a single `<body>...</body>`. |
| Allowed tags | `body`, `strong`/`b`, `em`/`i`, `u`, `s`, `code`, `ol`, `ul`, `li`, `a`, `blockquote`, `pre`. |
| NOT allowed | `<br>`, `<p>`, `<div>`, `<span>`, `<h1>`-`<h6>`, `<hr>`. Any one triggers the silent fallback. |
| Paragraphs | Comments have no reliable break tag. For multi-paragraph prose, drop the `html` flag and send plain text with real newlines. |
| @-mention | `<a data-asana-gid="USER_GID"></a>` (self-closing `<a data-asana-gid="USER_GID"/>` also works). Inner text is ignored and auto-filled. Resolve `USER_GID` via `asana_search_objects` with `resource_type="user"`; a profile/person GID will not render as a mention. |
| Notification | A mention only notifies that user if they are already a follower or assignee of the task. Otherwise add them as a follower first. |

**Good:**

```
html: true
text: <body>Ship cutoff is <strong>Friday</strong>. CC <a data-asana-gid="123"></a>.</body>
```

**Bad (refused by the guard):**

```
html: true
text: <p>One paragraph.</p><p>Another.</p>      // no <body>; <p> unsupported
```

## Image attachments on comments

`asana_add_comment` accepts local image paths via the `images` param (png, jpg, jpeg, gif, webp, bmp, svg). Asana's API has no comment-level upload, so the tool does what the Asana web app does: each file uploads to the task (`POST /attachments`, multipart, `parent` = task gid), and the comment embeds it inline with one [`<img data-asana-gid="GID"/>`](https://developers.asana.com/docs/rich-text) tag per attachment. The images render on the comment AND appear in the task's Files section.

Details worth knowing:

- Plain-text comments are XML-escaped and wrapped in `<body>` automatically; `html: true` bodies get the `<img>` tags spliced in before `</body>` after the normal validation.
- The upload omits `resource_subtype` on purpose: only the default (`asana`) subtype is accepted as an inline image; `external` attachments are rejected with "Not a valid image asset id".
- 100 MB per-file cap, mirroring Asana's own limit.
- Failure semantics: a failed upload aborts before the comment is posted, and the error names any files that DID attach (they stay on the task). If the comment post itself fails, the already-attached files remain in Files.
- Paths are checked (exists + supported type) before the review dialog opens.

## License

MIT

Based on the [Asana REST API](https://developers.asana.com/reference) and the [Asana MCP V2 tool reference](https://developers.asana.com/docs/mcp-tools-reference).
