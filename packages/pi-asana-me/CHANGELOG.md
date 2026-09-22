# Changelog

## 1.7.1 — 2026-09-10

### Fixed
- **Parallel gated tool calls no longer hang.** Same root cause and fix as pi-git-me 1.3.1: pi's TUI replaces an overlapping dialog and the replaced promise never settles, so a batch like three `asana_add_comment` calls showed one gate and hung the rest. `confirmWrite` now holds the shared process-wide dialog lock (`withDialogLock`, `Symbol.for("pi-me.dialog-lock")`) only while a dialog is open; queued prompts appear in turn, and the queue survives a throwing dialog. Lock tests added in `tests/confirm.test.ts`.

### Changed
- `setConfirmWriteEnabled` now writes atomically (temp file in the same directory + rename): a crash mid-write can no longer leave a truncated `pi-asana-me.json` that would silently reset the gate to its default on the next read.

## 1.7.0 — 2026-09-05

### Added
- **Image attachments on `asana_add_comment`.** New optional `images` param takes local file paths (png, jpg, jpeg, gif, webp, bmp, svg). Each file uploads to the task via `POST /attachments` (multipart, `parent` = task gid) and the comment embeds it inline with one `<img data-asana-gid="GID"/>` per attachment — the documented rich-text mechanism — so the image renders ON the comment and also lands in the task's Files section.
- `lib/attachments.ts` — image type detection/validation, XML escaping for the plain-text path (the story goes out as `html_text` whenever images are attached), and `buildStoryHtml` which wraps plain text or splices `<img>` tags before `</body>` in the `html: true` path (user markup is still validated by the existing guard first).
- `lib/api.ts` `callAsanaUpload` — multipart upload path (fetch `FormData`; no manual Content-Type so the boundary is set correctly). `resource_subtype` is deliberately never sent: only the default (`asana`) subtype is accepted as an inline image. 100 MB cap mirrors Asana's own per-attachment ceiling.
- Paths are validated (exists + supported type) BEFORE the review dialog. Failure semantics are reported exactly: a failed upload aborts before the story is posted and names any files that did attach (they stay on the task); a failed story post leaves the attachments in Files.

## 1.6.1 — 2026-08-12

### Added
- **`asana_update_comment`** &mdash; edit the text of a comment previously
  posted. Backed by `PUT /stories/{gid}` (plain `text` or `html_text`). The
  tool fetches the story first and refuses non-editable stories (system
  stories, other people's comments) before any write; only comments authored
  by the authenticated user are editable. Same html_text validation and
  write review gate as `asana_add_comment`; the editor is prefilled with the
  new replacement body. Tool surface: 18 &rarr; 19 tools.

## 1.6.0 — 2026-08-12

### Added
- **`asana_get_custom_fields`** &mdash; read every custom field on a task with its
  full shape: name, type (text/number/enum), current display value, gid, and
  (for enum) the legal option list. `asana_get_task` returns only a compact
  projection (gid/name/display_value), which hides the field type and the enum
  options an agent needs to write safely. Pair this tool with
  `asana_set_custom_fields`. Backed by `GET /tasks/{gid}` with a full
  `custom_fields.*` opt_fields projection.
- **`asana_set_custom_fields`** &mdash; set one or more custom fields on a task,
  keyed by field NAME (or gid). Enum option names resolve to option gids
  automatically; text and number values are coerced; `null` clears any type.
  Gated by the same review dialog as the other write tools. Backed by a schema
  `GET /tasks/{gid}` (to resolve names/options) followed by
  `PUT /tasks/{gid}` with a `custom_fields` body. Resolution is all-or-nothing:
  if any field is unresolvable, the whole batch is refused before the dialog
  and nothing is written.
- Tool surface: 16 &rarr; 18 tools. README + system-prompt `TOOL_GUIDANCE` and
  the `extensions/index.ts` header updated.

### Fixed
- **`asana_set_custom_fields` no longer writes a silent `0` on empty number
  input.** `Number("")` and `Number("   ")` are `0`, not `NaN`, so the NaN
  guard would have coerced an empty/whitespace value to `0`. The number branch
  now rejects empty strings and tells the agent to pass `null` to clear.
- **`asana_set_custom_fields` rejects unsupported field types explicitly**
  (`date`, `people`, `multi_enum`, `formula`, and anything later) instead of
  falling through to `String(value)` and surfacing an opaque Asana 400. The
  error names the type and the supported set.
- **Ambiguous field names are now refused.** A multi-project task can carry the
  SAME field name from two projects (distinct gids); name lookup previously
  picked the first silently and wrote to the wrong field. It now reports both
  gids and asks the agent to key by gid.
- **Disabled enum options can no longer be set.** Matching previously searched
  all options while the error list filtered to enabled ones; both paths now
  filter `enabled !== false`, so a disabled choice is rejected and the hint
  list matches.
- `fieldType()` (the `resource_subtype ?? type ?? "text"` normalization) moved
  into a shared `lib/custom-fields.ts`; the two tool files no longer carry
  duplicate copies.
- The `asana_set_custom_fields` confirm dialog now shows the task's **permalink
  URL** (it rides the existing schema GET, no extra round-trip), matching the
  other write tools.
- New `tests/custom-fields-get.test.ts` and `tests/custom-fields-set.test.ts`
  (21 tests) cover name/gid/case-insensitive resolution, enum option
  resolution, number coercion, null-clearing, the empty-number and
  unsupported-type rejections, ambiguity, disabled-option filtering, the
  all-or-nothing batch abort, a post-confirm PUT failure, the schema GET
  opt_fields, and the interactive review gate (cancel / proceed / dialog
  text) under `hasUI: true`.

## 1.5.5 — 2026-08-11

### Changed
- **`asana_add_comment` no longer echoes the posted content when the draft was not edited.** The content block and `details` are now emitted only when the human changed the draft in the review dialog. When the draft shipped verbatim the agent already has that text in its own context, so echoing it duplicated tokens for no information gain. The success line stays terse (e.g. `Asana: comment added to task 123 (story gid: 999, at ...).`).

## 1.5.4 — 2026-08-11

### Added
- **`asana_add_comment` reports the actual posted content and an `edited` flag.** The success result appends a labeled "Edited by user: yes|no / Final content sent" block, so the agent's later turns know exactly what reached Asana and whether the human changed the draft in the review dialog. The content is also mirrored into structured `details` as `{ postedContent, edited }`. Previously the tool returned only the story gid and timestamp, so after an edit the agent had no record of what actually shipped.

## 1.5.3 — 2026-08-10

### Added
- **`asana_add_comment` HTML validation + guidance.** When `html: true`, the tool validates the body against Asana's `html_text` rules and refuses to post payloads that would trigger Asana's silent literal-text fallback (missing `<body>` wrapper, or any unsupported tag such as `<br>`/`<p>`/`<div>`). Asana returns HTTP 201 for malformed `html_text` but stores the entire comment as literal text with the tags visible; the guard returns a precise reason instead so the agent can fix and retry. Plain-text comments (`html` falsy) are never validated. Backed by unit tests covering refusal (no `<body>`, `<br>`, `<p>`) and acceptance (valid body + mention).

### Changed
- Documented the Asana `html_text` contract in three agent-facing places: the `html` and `text` parameter descriptions (`lib/prompts.ts`), a rule line in the system-prompt `TOOL_GUIDANCE` (`extensions/index.ts`), and a new "Comment formatting (HTML &amp; mentions)" section in the README. The allowed tag set (body, strong/b, em/i, u, s, code, ol, ul, li, a, blockquote, pre), the `<a data-asana-gid="USER_GID"></a>` mention form, and the follower-required notification caveat are now spelled out so agents do not invent unsupported markup.
- Updated the pre-existing `html_text` test in `tests/me.test.ts` to use a valid `<body>`-wrapped payload; the prior `<b>hi</b>` example would now be (correctly) refused by the guard.

## 1.5.1 — 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent`, `pi-tui` dev pins to `^0.84.0`. Audited against the pi v0.84.0 breaking changes (renamed `ModelsRequestTransforms`, null-tolerant `getApiKeyAndHeaders` headers, dropped `message_update` partial fields, v4 session APIs); no code changes were needed and `tsc`/`typecheck` passes against 0.84.0.

## 1.5.0 — 2026-08-05

### Added
- `asana_list_attachments` &mdash; list the files and images attached to a task.
  Returns metadata only (gid, name, host, size, created_at, created_by), never
  binary, so the payload stays cheap. Covers BOTH files explicitly uploaded to
  a task AND images pasted inline into a comment thread (Asana stores both as
  attachments on the task). Backed by `GET /tasks/{gid}/attachments` with full
  pagination. Flags each row as asana-hosted (downloadable) or external-host
  (Drive/Dropbox/Box/OneDrive &mdash; view_url only).
- `asana_download_attachment` &mdash; download one attachment's bytes to a local
  file and return the absolute path. The agent then runs the `read` tool on the
  path to view an image, or parses a csv/xls/json from disk. Fills the gap that
  forced an agent to reuse a stale plugin CSV when a task referenced an updated
  XLS it could not fetch. Backed by `GET /attachments/{gid}` for metadata then a
  binary fetch of the returned `download_url`.
- `/asana attachments <gid>` and `/asana download <gid>` slash commands.

### Changed
- Two non-obvious Asana behaviors drive the download path, both handled in
  `lib/api.ts`'s new `downloadExternalUrl`:
  - Asana's `download_url` is an S3 presigned link that MUST be fetched WITHOUT
    the Bearer token (S3 returns 400/403 on Authorization). The helper sends no
    auth header; a test locks that invariant.
  - The URL expires after ~2 min. A non-2xx from S3 surfaces a retryable
    message pointing back at `asana_download_attachment` to refresh it.
  - A 120 s download timeout (vs the 30 s JSON timeout), a 100 MB size cap
    (preflight on Content-Length, post-read for the no-header case), and an
    abort-mapping around `arrayBuffer()` so a slow/large download fails with
    the retry hint rather than OOMing the agent or leaking a raw AbortError.
- External-host attachments (null `download_url`) cannot be auto-downloaded;
  the tool returns the `view_url` for the agent to open in a browser instead of
  pretending it can fetch them. An Asana-hosted attachment whose `download_url`
  is missing reports a retry (not a contradictory "externally hosted (asana)").
- The 404 "attachment not found" message is scoped to the metadata call only;
  an S3 403/404 from an expired link surfaces the retry hint instead (it would
  otherwise send the agent into a re-list loop on the same GID).
- Downloaded files land in a **per-process scratch dir** under `os.tmpdir()`
  (`lib/scratch-dir.ts`) that is wiped on process exit, so files never
  accumulate across sessions and the agent never needs a cleanup routine.
  `os.tmpdir()` is used (not a hardcoded `/tmp`) so it resolves correctly per
  platform: `/tmp` on Linux, the per-user sandbox temp on macOS, `%TEMP%` on
  Windows. An explicit `output_dir` override stays caller-owned (not
  auto-cleaned).
  - Cleanup fires on `process.exit` AND on SIGINT/SIGTERM/SIGHUP/SIGBREAK (the
    signals whose default disposition bypasses `exit`); handlers wipe the dir
    and re-raise so pi's own signal handling stays in control. A monotonic
    generation counter closes the reset-during-`mkdtemp` race so a reset can
    never leak a stray dir or a dangling exit listener.
- Caller- or Asana-supplied filenames are sanitized to a safe basename (path
  separators, drive letters, leading dots, NUL/shell chars, Windows reserved
  device names, 200-char length cap) so a hostile attachment name cannot escape
  `output_dir`.
- Tool surface: 14 &rarr; 16 tools. README + system-prompt TOOL_GUIDANCE updated
  to tell the agent when to reach for the attachment pair.

## 1.4.1 — 2026-07-29

### Changed
- `asana_add_comment` success summary now appends the task **permalink URL**
  (`URL: https://app.asana.com/0/…/…`) after the story gid, so the agent's
  recap carries a clickable link to where the comment landed. The confirm
  dialog already resolved the task for its title; the tool now reuses that
  resolved ref and falls back to one `GET /tasks/{gid}` in the headless /
  gate-off fast path. A resolve miss (deleted task, no access) omits the URL
  rather than failing the post. No trailing punctuation on the URL so it
  survives copy-paste.
- New `tests/comment-add.test.ts` locks the URL-present and URL-omitted
  contracts.

## 1.4.0 — 2026-07-21

### Changed
- The write-review confirm dialogs now show the task **name and permalink
  URL** instead of a bare GID, so a human can see exactly where a write will
  land before approving it:
  - `asana_add_comment` title reads `Post comment to 'Fix login'
    (https://app.asana.com/0/…/…)?` instead of `… task 1234567890123456?`.
  - `asana_update_tasks` renders each task (and its `parent`) as
    `'Name' (url)` in the yes/no summary.
  - `asana_create_tasks` resolves a subtask's `parent` the same way (new
    tasks have no URL of their own yet; the parent is where they land).
  - Any GID that fails to resolve (deleted task, no access, transient error)
  falls back to `gid: <gid>`, so a resolve miss never blocks a write.
  Backed by a new `lib/resolve.ts` (`resolveTasks` + `fmtTask`).
- Resolution runs **only when a prompt will actually be shown** — the new
  `willPromptForWrite(ctx)` helper gates the extra `GET /tasks/{gid}` calls,
  so the headless (`hasUI:false`) and gate-off fast paths are unchanged and
  pay nothing. `confirmWrite` itself stays pure (no Asana I/O).

## 1.3.0 — 2026-07-20

### Added
- `asana_get_comment` &mdash; fetch the full, untruncated body of a single
  comment (story) by its gid. `asana_get_task_comments` caps each comment at
  700 chars and prints the story gid in the truncation footer; this tool
  recovers the whole body on demand. Mirrors the
  `asana_get_task` / `asana_get_task_description` pairing, now for comments.
  Backed by `GET /stories/{story_gid}`.
- `/asana comment <story gid>` slash command for direct single-comment fetch.

### Changed
- `asana_get_task_comments` truncation footer now names the recovery tool and
  parameter (`call asana_get_comment with story_gid=...`) instead of the
  generic `fetch story gid ... for full text`, so the agent has an actionable
  next step instead of a dead end.
- Comment truncation cap lowered from 800 to 700 chars (named const
  `COMMENT_LIMIT` in `lib/tools/comment-list.ts`, mirroring `NOTES_LIMIT`
  in `lib/tools/task.ts`).
- `asana_get_task` notes cap docstring/guidance corrected: the CODE has
  capped at 2000 chars since 1.1.0, but stale "~400 chars" lingered in the
  TOOL_GUIDANCE system-prompt appendix, the README reach-for list, and the
  `asana_get_task_description` docstring. Code wins; docs corrected to 2000.
- Tool surface: 13 &rarr; 14 tools.
- Renamed `lib/tools/comment.ts` &rarr; `comment-add.ts` and
  `lib/tools/task-comments.ts` &rarr; `comment-list.ts` so the three comment
  tools (`comment-add`, `comment-get`, `comment-list`) sort together.
  Symbols and tool names unchanged; imports updated in `extensions/index.ts`
  and the tests.
- `asana_get_comment` now indents the comment body 2 spaces, matching the
  list view in `asana_get_task_comments` so concatenated output reads
  consistently.

## 1.2.1 — 2026-07-09

### Changed
- The three write tools are now flat `export const` objects, uniform with
  the read tools. `confirmWrite` takes no `pi` arg: it never read `pi.getFlag`
  (flags are in-memory only with no setter, so the gate is file-backed), making
  the prior `createXxxTool(pi)` factory's `pi` arg vestigial. Tool behavior and
  parameters are unchanged.
- Removed the orphaned `makePi()` test helper. Fixed a stale `me.test` comment
  that attributed gate-bypass to the flag value when it is actually the headless
  ctx (`hasUI:false`).

## 1.2.0 — 2026-07-09

### Added
- Review-before-post gate on the three write tools (`asana_add_comment`,
  `asana_create_tasks`, `asana_update_tasks`). When enabled (default), each
  write prompts the user before hitting the Asana API:
  - `asana_add_comment` opens the drafted comment in an editable preview —
    trim the model's prose, then accept (Enter) or cancel (Esc). The posted
    text is whatever you leave in the editor.
  - `asana_create_tasks` / `asana_update_tasks` show a readable summary of
    the batch and ask yes/no.
  - In headless sessions (no interactive UI) the gate is skipped so
    unsupervised runs are never deadlocked.
- `/asana config` — settings modal (TUI) to toggle the review gate, or a
  status line in non-interactive modes.
- `/asana confirm on|off` — one-shot shorthand for the toggle.

### Changed
- Write tools stay as flat `export const` tool objects, uniform with the read
  tools. The confirm gate takes no `pi`: it never read `pi.getFlag` anyway
  (flags are in-memory only with no setter), so an earlier factory form's `pi`
  arg was vestigial. The gate reads file-backed state directly. Tool behavior
  and parameters are otherwise unchanged.
- The `/asana` tool guidance injected via `before_agent_start` now tells the
  agent the review prompt is handled by the extension, so the agent should
  call write tools directly rather than asking the user itself.

### Fixed
- Removed dead code in `asana_update_tasks` (an unused type alias and an
  unreachable try/catch around the final result formatting).

### Notes for integrators

The gate value is persisted in `<piDir>/pi-asana-me.json` (`{ "confirmWrite":
bool }`), where `<piDir>` is `process.env.PI_CODING_AGENT_DIR || ~/.pi/agent`.
Pi's extension flags (`pi.registerFlag`) are in-memory only with no persistence
path, so this extension owns its own tiny settings file rather than relying on
`pi config set` (which does not touch flags). The `asana-confirm-write` flag is
still registered for `/settings` visibility and the `--asana-confirm-write` CLI
override, but the gate reads the JSON file.

## 1.1.0 — 2026-07-08

### Added
- `asana_get_task_description` — full, untruncated task notes/description
  for a single GID. `asana_get_task` caps `notes` at ~2000 chars to keep its
  default payload cheap, which hides the acceptance criteria, background,
  and implementation detail an agent needs to actually perform the task.
  When the cap fires, `asana_get_task` now prints a
  `[truncated; call asana_get_task_description for the full text]` marker;
  the agent reaches for this tool to recover the whole body. Asks only for
  `name,notes`, no other projection.

### Changed
- `asana_get_task` no longer silently slices `notes` at 400 chars. It now caps
  at 2000 chars (most real task specs render inline; only very long bodies
  trip the marker) and prints an explicit marker pointing at
  `asana_get_task_description` when the body overflows. Notes at or under the
  cap render inline, unchanged. Also fixed: empty-string `notes` previously
  dropped the line entirely (falsy guard); now renders as an empty line via a
  type-based guard.

## 1.0.0 — 2026-07-06

Initial release.

Pi-native Asana Work Graph tools. Calls the Asana REST API directly over plain
HTTP, with no MCP server install required — mirrors the official Asana MCP tool
surface without the OAuth MCP-app dance.

### Added
- `asana_search_objects` — keyword search via the Asana typeahead endpoint,
  one resource type per call (single enum: task / project / user / tag).
  Defaults to `task`. First step when a GID is unknown.
- `asana_get_my_tasks` — tasks assigned to the authenticated user, scoped to
  a workspace. Asana requires `(assignee AND workspace)` together; the tool
  enforces that by making `workspace` a required parameter.
- `asana_get_tasks` — filtered task list (project, section, tag, assignee,
  workspace). Validates filter combinations at the tool boundary before any
  network round-trip.
- `asana_get_task` — full detail on a single task: name, notes, assignment,
  due / start dates, parent task, project and section memberships, tags,
  custom fields, subtasks, dependencies, dependents, and followers. Comments
  are NOT included (Asana exposes them via a separate stories endpoint);
  see `asana_add_comment` for posting.
- `asana_get_project` — full detail on a single project.
- `asana_get_projects` — list projects in a workspace or team.
- `asana_get_status_overview` — aggregated status report across one or more
  projects via the latest project statuses endpoint.
- `asana_get_me` — identity and workspace membership for the authenticated
  user.
- `asana_create_tasks` — create up to 50 tasks in a single call. Rejects
  the dual-spec case (`projects` array AND `project` singular set on the
  same task) rather than overwriting one with the other.
- `asana_update_tasks` — update up to 50 tasks in a single call.
- `asana_add_comment` — add a text or HTML comment to a task.
- `asana_get_task_comments` — most-recent human comments on a task. Added
  on-demand (not baked into `asana_get_task`) because comment threads are
  conversational context and often return long payloads; the
  default task fetch stays cheap. Default limit 5, max 50. Reverse
  chronological. Filters out system events (status changes, etc.) by
  `resource_subtype=comment`.
- `/asana <verb> [args]` slash command (`me`, `my`, `show`, `project`,
  `search`, `status`, `comments`, `create`). Registered programmatically via
  `registerCommand`. Prefills the editor with an explicit ask.
- Compact tool guidance injected via `before_agent_start` (~80 tokens, no
  skill file).
- Inline REST client (`lib/api.ts`) handling auth headers, JSON `data`
  envelope for write bodies, timeouts, and friendly status errors
  (401 / 404 / 429 / 5xx).
- `lib/auth.ts` — reads `ASANA_ACCESS_TOKEN` from the environment. Strictly
  env-only: no file fallback, no config file, no other env vars.

### Notes for integrators

Notable findings from build-time review and live testing, all resolved in this
release:

- `asana_search_objects` was originally wired against the typeahead endpoint
  with `resource_types` (plural) and `limit`; the endpoint actually takes
  `resource_type` (singular) and `count`, and accepts only one type per call.
  Tool now defaults to `task` and accepts an override.
- `asana_get_task` originally requested no `subtasks` in its default
  `opt_fields`, so a closed parent task with N closed subtasks rendered as
  "no subtasks". Default projection now requests `subtasks.name`,
  `subtasks.completed`, `subtasks.completed_at`, and `subtasks.assignee.name`;
  the renderer surfaces them as a counted list.
- Write tools (`asana_create_tasks`, `asana_update_tasks`, `asana_add_comment`)
  originally sent raw bodies; Asana REST requires every POST/PUT body wrapped
  under `{"data": {...}}`. The wrapper lives once in `lib/api.ts`, symmetric
  with the response-side `{data}` unwrap.
- `asana_get_tasks` originally accepted `assignee`-only or `workspace`-only
  filters, which Asana rejects with 400. Rejected at the tool boundary with
  an actionable error before the network round-trip.

### Credits

Based on the [Asana REST API](https://developers.asana.com/reference) and
the [Asana MCP V2 tool reference](https://developers.asana.com/docs/mcp-tools-reference).
