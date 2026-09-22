// Tool titles, descriptions, and parameter descriptions. Kept as constants so
// the tool modules stay lean and the wording is reviewable in one place.
// Descriptions are the model's main steering surface: they carry the accepted
// input shapes, the gotchas (HTML bodies, visibility), and the follow-up paths.

export const GET_TICKET_TITLE = "Get Zendesk ticket";
export const GET_TICKET_DESCRIPTION =
  "Fetch one Zendesk ticket with requester, assignee, and organization resolved in a single call. " +
  "Accepts a numeric ticket id or a pasted agent URL such as https://{subdomain}.zendesk.com/agent/tickets/7942. " +
  "Returns subject, status, priority, people, tags, timestamps, and the stripped plain-text description. " +
  "Read-only.";
export const GET_TICKET_PARAM =
  'Ticket id ("7942") or full agent URL ("https://{subdomain}.zendesk.com/agent/tickets/7942").';
export const GET_TICKET_INCLUDE_DESCRIPTION =
  'Extra side-loaded records beyond the default "users,organizations" (e.g. ["groups"]).';

export const GET_COMMENTS_TITLE = "Get Zendesk ticket comments";
export const GET_COMMENTS_DESCRIPTION =
  "Read the full comment thread of a Zendesk ticket: public replies and internal notes (flagged as such), " +
  "newest last, with author names resolved via side-loading. Accepts a numeric ticket id or a pasted agent URL. " +
  "Bodies are returned as stripped plain text. Read-only.";
export const GET_COMMENTS_PARAM =
  'Ticket id ("7942") or full agent URL ("https://{subdomain}.zendesk.com/agent/tickets/7942").';
export const GET_COMMENTS_LIMIT_DESCRIPTION =
  "Render only the N most recent entries (default 20). Older entries are counted, not fetched twice - the thread arrives in one call either way.";
export const GET_COMMENTS_PUBLIC_ONLY_DESCRIPTION =
  "When true, hide internal notes and render public replies only. Default false.";

export const SEARCH_TITLE = "Search Zendesk tickets";
export const SEARCH_DESCRIPTION =
  "Search the Zendesk tenant. The query is sent to the search API; type:ticket is prepended unless the query already constrains a type or all_types is set. " +
  "Use Zendesk search syntax: status:open, priority:urgent, requester:1042, organization:77, tags:billing, plus free text. " +
  "Read-only.";
export const SEARCH_QUERY_DESCRIPTION =
  'Zendesk search query, e.g. "status:open priority:urgent billing" or "requester:1042".';
export const SEARCH_LIMIT_DESCRIPTION =
  "Max results per page (default 25, max 100).";
export const SEARCH_ALL_TYPES_DESCRIPTION =
  "When true, do not prepend type:ticket - results may include users and organizations. Default false.";

export const GET_USER_TITLE = "Get Zendesk user";
export const GET_USER_DESCRIPTION =
  "Look up one Zendesk user by id: name, email, role, active flag, organization, notes. " +
  "Use the requester_id / assignee_id returned by zendesk_get_ticket or zendesk_search. Read-only.";
export const GET_USER_PARAM = "Numeric Zendesk user id.";

export const GET_ORG_TITLE = "Get Zendesk organization";
export const GET_ORG_DESCRIPTION =
  "Look up one Zendesk organization by id: name, domains, details, notes, tags. " +
  "Use the organization_id returned by zendesk_get_ticket or zendesk_search. Read-only.";
export const GET_ORG_PARAM = "Numeric Zendesk organization id.";

export const DOWNLOAD_TITLE = "Download Zendesk ticket attachment";
export const DOWNLOAD_DESCRIPTION =
  "Download one ticket attachment to a local temp file so it can be viewed. " +
  "Find the attachment id in zendesk_get_comments output (lines like 'attachment: #ID name'). " +
  "After downloading, view images with the native `read` tool on the returned path. Read-only: writes only to the OS temp dir.";
export const DOWNLOAD_PARAM_TICKET =
  'Ticket id ("7942") or full agent URL ("https://{subdomain}.zendesk.com/agent/tickets/7942").';
export const DOWNLOAD_PARAM_ID =
  "Numeric Zendesk attachment id (from zendesk_get_comments output).";

export const GET_VIEW_TITLE = "Get Zendesk view tickets";
export const GET_VIEW_DESCRIPTION =
  "List the tickets in a saved Zendesk view (called a filter in the agent UI, URLs look like https://{subdomain}.zendesk.com/agent/filters/20824934716439). " +
  "Returns the view title and its matching tickets with requester and assignee resolved. Read-only.";
export const GET_VIEW_PARAM =
  'View id ("20824934716439") or full agent URL ' +
  '("https://{subdomain}.zendesk.com/agent/filters/20824934716439").';
export const GET_VIEW_LIMIT_DESCRIPTION =
  "Max tickets to render (default 25, max 100).";
