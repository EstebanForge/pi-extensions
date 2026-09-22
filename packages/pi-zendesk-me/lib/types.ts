// Zendesk Support API v2 types. Only the fields this extension renders; the
// API returns more and we ignore the rest.

export const TICKET_STATUSES = [
  "new",
  "open",
  "pending",
  "hold",
  "solved",
  "closed",
] as const;
export type ZdTicketStatus = (typeof TICKET_STATUSES)[number];

export interface ZdTicket {
  id: number;
  subject: string | null;
  /** First comment body (HTML). Present on the single-ticket record, not on search results. */
  description?: string | null;
  status: ZdTicketStatus;
  priority: "urgent" | "high" | "normal" | "low" | null;
  type: string | null;
  requester_id: number;
  submitter_id: number;
  assignee_id: number | null;
  organization_id: number | null;
  group_id: number | null;
  tags?: string[];
  created_at: string;
  updated_at: string;
  due_at?: string | null;
  url?: string;
}

export interface ZdComment {
  id: number;
  /** May contain HTML. */
  body: string | null;
  html_body?: string | null;
  plain_body?: string | null;
  /** False means internal note. */
  public: boolean;
  author_id: number;
  created_at: string;
  attachments?: ZdAttachment[];
  via?: { channel?: string; source?: unknown };
}

export interface ZdAttachment {
  id: number;
  file_name: string;
  content_url?: string;
  size?: number;
  content_type?: string;
  inline?: boolean;
}

export interface ZdUser {
  id: number;
  name: string;
  email?: string | null;
  active: boolean;
  role: string;
  locale?: string;
  time_zone?: string;
  created_at?: string;
  updated_at?: string;
  organization_id?: number | null;
  details?: string | null;
  notes?: string | null;
  tags?: string[];
}

export interface ZdOrganization {
  id: number;
  name: string;
  domain_names?: string[];
  details?: string | null;
  notes?: string | null;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

// Side-loaded records ride at the top level of a response:
//   GET /api/v2/tickets/7942.json?include=users,organizations
//   => { ticket: {...}, users: [...], organizations: [...] }
export interface ZdSideLoads {
  users?: ZdUser[];
  organizations?: ZdOrganization[];
  groups?: Array<{ id: number; name: string }>;
}

export interface ZdTicketResponse extends ZdSideLoads {
  ticket: ZdTicket;
}

export interface ZdCommentsResponse extends ZdSideLoads {
  comments: ZdComment[];
}

export interface ZdSearchResponse {
  results: Array<ZdTicket & { result_type: string }>;
  count: number;
  next_page: string | null;
  previous_page: string | null;
}

export interface ZdUserResponse {
  user: ZdUser;
}

export interface ZdOrgResponse {
  organization: ZdOrganization;
}

export interface ZdView {
  id: number;
  title?: string;
  active?: boolean;
}

export interface ZdViewResponse {
  view: ZdView;
}

export interface ZdViewExecuteRow {
  ticket: ZdTicket;
}

export interface ZdViewExecuteResponse extends ZdSideLoads {
  rows: ZdViewExecuteRow[];
  count?: number;
  next_page?: string | null;
  previous_page?: string | null;
}
