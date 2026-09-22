// Tool titles, descriptions, and per-parameter descriptions adapted from the
// official Asana MCP server tool set
// (https://developers.asana.com/docs/mcp-tools-reference) and the Asana REST
// API reference. Rewritten so the pi agent knows exactly WHEN to reach for
// each one and what the parameters map to.
//
// Curated set, not a 1:1 mirror of the official MCP server: we skip the
// noisy/duplicate/UI-only MCP tools and add a few purpose-built recovery
// tools (full-body fetches) the MCP set lacks. Skipped MCP tools (with reason):
//   - search_tasks          (Premium-only; overlaps asana_search_objects)
//   - get_portfolio(s)      (niche in agent flows)
//   - get_items_for_portfolio (niche)
//   - get_user / get_users  (use asana_search_objects with resource_type=user)
//   - get_teams             (rarely requested)
//   - get_agent(s)          (AI Teammates only)
//   - delete_task           (destructive; add later if needed)
//   - create_project        (high-blast-radius; add later)
//   - create_project_status_update (niche)
//   - *preview tools        (Claude/ChatGPT confirmation UI; no UI in pi)
// Attachments are supported, split into a metadata list
// (asana_list_attachments) and a disk download (asana_download_attachment)
// instead of the MCP server's binary-blob get_attachments.

// ---------------------------------------------------------------- search ---

export const SEARCH_TITLE = "Asana: Search Objects";

export const SEARCH_DESCRIPTION = `Keyword search across workspace via typeahead. Use FIRST when GID is unknown to resolve partial names. Call once per resource_type ("task" | "project" | "user" | "tag", defaults to "task"); no cross-type search. Returns list of matches with GIDs. Requires workspace GID (get from asana_get_me if unknown).`;

export const SEARCH_WORKSPACE_DESCRIPTION =
  "Workspace GID (e.g. \"1234567890123456\"). Get from asana_get_me if unknown.";

export const SEARCH_QUERY_DESCRIPTION =
  "Search term matching names. Empty string returns recently contacted users or visited projects depending on resource_type.";

export const SEARCH_RESOURCE_TYPE_DESCRIPTION =
  "Type to search: \"task\" | \"project\" | \"user\" | \"tag\". Defaults to \"task\".";

export const SEARCH_LIMIT_DESCRIPTION =
  "Limit results (1-100). Defaults to 20.";

// ------------------------------------------------------------------ me ---

export const ME_TITLE = "Asana: Get Authenticated User";

export const ME_DESCRIPTION = `Identity and workspace membership of ASANA_ACCESS_TOKEN owner. Use when user asks "who am I" or when workflow needs workspace/user GID. Call at session start if workspace GID is unknown.`;

export const ME_OPT_FIELDS_DESCRIPTION =
  "Optional comma-separated opt_fields (e.g. \"email,workspaces.name\"). Defaults: name, email, gid, resource_type, workspaces.";

// --------------------------------------------------------------- task(s) ---

export const GET_TASK_TITLE = "Asana: Get Task";

export const GET_TASK_DESCRIPTION = `Full detail for task GID: name, notes, assignee, dates, parent, projects, sections, tags, custom fields, subtasks, dependencies. Use AFTER asana_search_objects or asana_get_tasks returns a GID. Excludes comments/stories (use asana_get_task_comments for discussion, or asana_add_comment to post).`;

export const GET_TASK_GID_DESCRIPTION =
  "Task GID (e.g. \"1234567890123456\").";

export const GET_TASK_OPT_FIELDS_DESCRIPTION =
  "Optional opt_fields. Default includes subtasks, dependencies, parent, custom fields.";

export const GET_TASK_NOTES_TITLE = "Asana: Get Task Description";

export const GET_TASK_NOTES_DESCRIPTION = `Full, untruncated notes (description) for a single task GID. asana_get_task caps notes at ~2000 chars to keep its payload cheap; call THIS tool when you need the complete description body to understand or perform the task (e.g. acceptance criteria, background, implementation notes). Returns only gid, name, and the full notes (output labeled \`description:\`). Use AFTER you already have a task GID from asana_search_objects, asana_get_tasks, or asana_get_task.`;

export const GET_TASKS_TITLE = "Asana: List Tasks";

export const GET_TASKS_DESCRIPTION = `Filtered list of tasks. Require at least one of: project, section, tag, OR (assignee AND workspace). Assignee alone or workspace alone both 400. Use for bulk reads. For partial name search, prefer asana_search_objects.`;

export const GET_TASKS_PROJECT_DESCRIPTION =
  "Project GID filter.";

export const GET_TASKS_SECTION_DESCRIPTION =
  "Section GID filter. Must belong to the project parameter.";

export const GET_TASKS_TAG_DESCRIPTION =
  "Tag GID filter.";

export const GET_TASKS_ASSIGNEE_DESCRIPTION =
  "Assignee: \"me\" or user GID. Omit (and provide project/section/tag) for all tasks in scope.";

export const GET_TASKS_WORKSPACE_DESCRIPTION =
  "Workspace GID. Required only if assignee is set (prevents 400).";

export const GET_TASKS_COMPLETED_SINCE_DESCRIPTION =
  "ISO 8601 timestamp. Returns tasks completed after this instant.";

export const GET_TASKS_COMPLETED_BEFORE_DESCRIPTION =
  "ISO 8601 timestamp. Bounds completion window with completed_since.";

export const GET_TASKS_MODIFIED_SINCE_DESCRIPTION =
  "ISO 8601 timestamp. Tasks modified after this instant.";

export const GET_TASKS_LIMIT_DESCRIPTION =
  "Limit results (1-100). Defaults to 50.";

export const GET_MY_TASKS_TITLE = "Asana: Get My Tasks";

export const GET_MY_TASKS_DESCRIPTION = `Shortcut for asana_get_tasks with assignee=me. Requires workspace GID (calling with assignee=me alone 400s). Get workspace via asana_get_me. Returns assigned tasks, filtered by completed status ("incomplete" or "completed", default returns both). Use for "my tasks" or "what's on my plate".`;

export const GET_MY_TASKS_COMPLETED_DESCRIPTION =
  "Filter: \"incomplete\" or \"completed\". Omit for both.";

// ------------------------------------------------------------- project(s) ---

export const GET_PROJECT_TITLE = "Asana: Get Project";

export const GET_PROJECT_DESCRIPTION = `Full detail for project GID. Use AFTER resolving project GID via search. Set include_sections=true to include sections in the response.`;

export const GET_PROJECT_GID_DESCRIPTION = "Project GID.";

export const GET_PROJECT_INCLUDE_SECTIONS_DESCRIPTION =
  "Include sections array in response.";

export const GET_PROJECT_OPT_FIELDS_DESCRIPTION =
  "Optional opt_fields (e.g. \"owner.name\", \"members.name\", \"task_counts.completed\").";

export const GET_PROJECTS_TITLE = "Asana: List Projects";

export const GET_PROJECTS_DESCRIPTION = `List projects in workspace or team. Workspace-based by default. Set team to restrict. Set archived=true to include archived projects. Use to list projects before drilling in.`;

export const GET_PROJECTS_WORKSPACE_DESCRIPTION =
  "Workspace GID. Omit if team is passed, or pass together to disambiguate. If neither set, returns projects across all workspaces (noisy).";

export const GET_PROJECTS_TEAM_DESCRIPTION =
  "Team GID to restrict projects.";

export const GET_PROJECTS_ARCHIVED_DESCRIPTION =
  "Include archived projects.";

// ------------------------------------------------------- status_overview ---

export const STATUS_OVERVIEW_TITLE = "Asana: Status Overview";

export const STATUS_OVERVIEW_DESCRIPTION = `Aggregated status report for projects or portfolios matched by keyword. Includes details, updates, summaries, blockers. Performs internal search, do NOT call asana_search_objects or asana_get_projects first. Use for "what is the status of X".`;

// ----------------------------------------------------------------- writes ---

export const CREATE_TASKS_TITLE = "Asana: Create Tasks";

export const CREATE_TASKS_DESCRIPTION = `Create up to 50 tasks. Use AFTER target project GID is known. Resolve assignee/due dates to valid GIDs via asana_search_objects first to avoid errors. Tasks created immediately without confirmation.`;

export const CREATE_TASKS_NAME_DESCRIPTION =
  "Task title. Required. Matched 1:1 with tasks array. Defaults to \"Untitled task\" if omitted.";

export const CREATE_TASKS_WORKSPACE_DESCRIPTION =
  "Workspace GID (e.g. \"1234567890123456\"). Required unless project, assignee, or parent is provided for every task.";

export const CREATE_TASKS_TASKS_DESCRIPTION =
  "Array (1-50) of tasks: name, notes, projects (GID array), section (GID), parent (task GID), assignee (GID or \"me\"), due_on (YYYY-MM-DD), start_on, followers (GID array), custom_fields (object).";

export const UPDATE_TASKS_TITLE = "Asana: Update Tasks";

export const UPDATE_TASKS_DESCRIPTION = `Update up to 50 tasks. Fields: name, assignee, dates, notes, completed (boolean), parent, dependencies, projects, followers, custom_fields. Use for batch updates or closes. Only pass fields to change.`;

export const UPDATE_TASKS_TASKS_DESCRIPTION =
  "Array (1-50) of updates. Each requires task GID (\"gid\") and at least one mutable field (e.g. { \"gid\": \"...\", \"completed\": true }).";

export const UPDATE_TASKS_OPT_FIELDS_DESCRIPTION =
  "Optional opt_fields. Defaults to \"name,completed\".";

// ----------------------------------------------------------- custom fields -

export const GET_CUSTOM_FIELDS_TITLE = "Asana: Get Custom Fields";

export const GET_CUSTOM_FIELDS_DESCRIPTION = `Read every custom field on a task: name, type (text/number/enum), current display value, gid, and enum options. Use before asana_set_custom_fields to learn what is settable and to discover the legal enum option names. Not gated. asana_get_task returns only a compact custom_fields projection; this tool returns the full shape.`;

export const GET_CUSTOM_FIELDS_GID_DESCRIPTION =
  "Task GID (e.g. \"1234567890123456\"). Get from workspace, search, or parent task.";

export const SET_CUSTOM_FIELDS_TITLE = "Asana: Set Custom Fields";

export const SET_CUSTOM_FIELDS_DESCRIPTION = `Set one or more custom fields on a task. Key the \`fields\` map by field NAME (or gid): { "Testing Site": "https://..." }. Enum values are matched to option names and resolved to option gids automatically; text and number values are coerced. Pass null to clear a field. Gated by the same review dialog as the other write tools. Discover field names and enum options first with asana_get_custom_fields.`;

export const SET_CUSTOM_FIELDS_TASK_GID_DESCRIPTION =
  "Task GID (e.g. \"1234567890123456\").";

export const SET_CUSTOM_FIELDS_FIELDS_DESCRIPTION =
  "Map of { field_name: value }. Key by field name (or gid). Text -> string, number -> number, enum -> option name. null clears. Example: { \"Testing Site\": \"https://oba.ind.ninja/\", \"Status\": \"In Progress\" }.";

export const ADD_COMMENT_TITLE = "Asana: Add Comment";

export const ADD_COMMENT_DESCRIPTION = `Post a comment (story) to a task. Use for discussion, not auto-logged actions. Body defaults to plain text; set html=true to send Asana html_text for @-mentions or inline formatting. When html=true the body MUST follow the html_text rules on the \`text\` parameter (single <body> wrapper, allowed tags only) or Asana silently stores the ENTIRE comment as literal text with the tags visible and NO error (HTTP 201). Attach local images with images (png/jpg/gif/webp/bmp/svg): each uploads to the task and renders inline on the comment.`;

export const ADD_COMMENT_TASK_DESCRIPTION = "Target task GID.";

export const ADD_COMMENT_HTML_DESCRIPTION =
  "Send the \`text\` as Asana html_text instead of plain text. Default false. Only use when you need an @-mention or inline formatting (bold/italic/code/list); for plain prose keep it false. When true, \`text\` MUST be valid Asana html_text: wrapped in a single <body>...</body> and using ONLY allowed tags (see the \`text\` parameter docs). The tool refuses to post html_text that would trigger Asana's silent literal-text fallback.";

export const ADD_COMMENT_TEXT_DESCRIPTION = [
  "Comment body. Plain text by default; real newlines render as line breaks.",
  "Set html=true ONLY for @-mentions or inline formatting. In html mode the body is sent as Asana html_text and MUST follow these rules, or Asana silently stores the ENTIRE comment as literal text (tags visible, no error, HTTP 201):",
  "- Wrap everything in a single <body>...</body>.",
  "- Allowed tags ONLY: body, strong/b, em/i, u, s, code, ol, ul, li, a, blockquote, pre.",
  "- NOT allowed (any one triggers the silent literal-text fallback): <br>, <p>, <div>, <span>, <h1>-<h6>, <hr>. For multi-paragraph prose, use plain text (html omitted/false) with real newlines instead.",
  "- @-mention: <a data-asana-gid=\"USER_GID\"></a> (self-closing <a data-asana-gid=\"USER_GID\"/> also works). Inner text is ignored and auto-filled by Asana. Resolve USER_GID via asana_search_objects with resource_type=\"user\"; a profile/person GID will not render as a mention.",
  "- A mention only notifies that user if they are already a follower or assignee of the task; otherwise add them as a follower first.",
  "- Escape literal < and & in prose; > is allowed in text content (so PHP \"=>\" is fine).",
].join(" ");

export const ADD_COMMENT_IMAGES_DESCRIPTION =
  "Local image file paths to attach (png, jpg, jpeg, gif, webp, bmp, svg). Each file uploads to the task (POST /attachments) and the comment embeds it inline via <img data-asana-gid>. Attached images also appear in the task's Files section.";

export const UPDATE_COMMENT_TITLE = "Asana: Update Comment";

export const UPDATE_COMMENT_DESCRIPTION = `Edit the text of a comment previously posted. Use to correct a comment you (the agent, via asana_add_comment, or the authenticated user) already posted. Only comments authored by the authenticated user are editable; system stories and other people's comments are refused (post a new comment instead). The tool fetches the existing body first and refuses non-editable stories before any write. Review-gated like the other write tools: the editor is prefilled with the NEW text.`;

export const UPDATE_COMMENT_STORY_GID_DESCRIPTION =
  "Story (comment) GID to edit, e.g. \"1234567890123456\". Copy it from asana_get_task_comments output (\"(story gid: ...)\") or a prior asana_add_comment result.";

export const UPDATE_COMMENT_TEXT_DESCRIPTION =
  "The FULL replacement comment body (not a delta). Plain text by default; same rules as asana_add_comment's text parameter.";

export const UPDATE_COMMENT_HTML_DESCRIPTION =
  "Send the `text` as Asana html_text instead of plain text. Same rules and validation as asana_add_comment's html parameter.";

// ----------------------------------------------------- task comments (read) -

export const TASK_COMMENTS_TITLE = "Asana: Get Task Comments";

export const TASK_COMMENTS_DESCRIPTION = `Get recent human comments on a task. Comments contain discussion/decisions NOT in description (excludes system events). Use when user asks about discussion or comments on a task. Not inlined in asana_get_task. Defaults to 5 newest (newest first). Long comments truncate at 700 chars; the footer names the story_gid to pass to asana_get_comment for the full body. Filters by Asana's top-level \`type\` field (value "comment"); the \`resource_subtype\` field is an action verb like "comment_added" or "description_changed" and is NOT the discriminator.`;

export const TASK_COMMENTS_TASK_GID_DESCRIPTION =
  "Task GID (e.g. \"1234567890123456\"). Get from workspace, search, or parent task.";

export const TASK_COMMENTS_LIMIT_DESCRIPTION =
  "Count of recent comments to return (1-50). Defaults to 5.";

// asana_get_comment: recover the full body of a single truncated comment.
// asana_get_task_comments truncates each comment at 700 chars and prints
// the story gid in the truncation footer; call THIS tool with that gid to
// get the whole text. Mirrors the asana_get_task / asana_get_task_description
// pairing for task notes.
export const GET_COMMENT_TITLE = "Asana: Get Comment";

export const GET_COMMENT_DESCRIPTION = `Full, untruncated text of a single comment (story). asana_get_task_comments truncates each comment at 700 chars and prints the story gid in the truncation footer; call THIS tool with that story_gid to read the whole body. Returns the comment with NO slice. Use AFTER you already have a story gid from asana_get_task_comments's output.`;

export const GET_COMMENT_STORY_GID_DESCRIPTION =
  "Story (comment) GID, e.g. \"1234567890123456\". Copy it from asana_get_task_comments output, where each comment is labeled \"(story gid: ...)\".";

// --------------------------------------------------------- attachments (files/images) ---

// Attachments live on a task (files uploaded to the task, OR images pasted
// inline into a comment - both are attachments under the hood). The official
// Asana MCP server ships a single get_attachments that returns binary blobs;
// that is hostile to an LLM agent context. We split it in two: a cheap metadata
// list, and an on-demand binary download that writes to disk and returns a
// local path the agent can then `read` (images) or parse (xls/csv/json).
export const ATTACHMENTS_LIST_TITLE = "Asana: List Task Attachments";

export const ATTACHMENTS_LIST_DESCRIPTION = `List files and images attached to a task. Covers BOTH files uploaded to the task AND images pasted inline into comments (inline images are attachments too). Returns metadata only: gid, name, host, size, created_at, created_by - NO binary. Use when a task or comment references a file/image you need to open, or to discover the attachment_gid for asana_download_attachment. For the XLS/CSV/PDF/ZIP the user mentioned, or an image pasted into a comment thread, start here.`;

export const ATTACHMENTS_LIST_TASK_GID_DESCRIPTION =
  "Task GID whose attachments to list (e.g. \"1234567890123456\"). Get from asana_search_objects / asana_get_task / a comment thread.";

export const ATTACHMENT_DOWNLOAD_TITLE = "Asana: Download Attachment";

export const ATTACHMENT_DOWNLOAD_DESCRIPTION = `Download one attachment's bytes to a local file and return the path. Use to open an XLS/CSV/PDF/ZIP a task references, or to fetch an image so you can view it (run the read tool on the returned path for images). For Asana-hosted files: writes the file to disk and returns the absolute path. For external hosts (Google Drive/Dropbox/Box/OneDrive): cannot auto-download; returns the view_url for the agent to open in a browser. Use AFTER asana_list_attachments gives you an attachment_gid.`;

export const ATTACHMENT_DOWNLOAD_GID_DESCRIPTION =
  "Attachment GID to download (e.g. \"1234567890123456\"). Get from asana_list_attachments output.";

export const ATTACHMENT_DOWNLOAD_OUTPUT_DIR_DESCRIPTION =
  "Directory to write the file into. When omitted, writes into a per-process temp dir under the OS temp folder that is auto-removed when the pi session ends, so files never accumulate and you do NOT need to clean them up. Pass this only when you want to keep the file beyond the session; a caller-supplied dir is caller-owned (not auto-cleaned). Absolute or relative; the filename is always the attachment's own name.";

export const ATTACHMENT_DOWNLOAD_FILENAME_DESCRIPTION =
  "Override filename (basename only; directory components stripped). Defaults to the attachment's own name, or the attachment gid when Asana omits the name.";
