// Concrete Asana response shapes, one per resource type. Shared across all
// tool files so we stop hand-rolling inline types per tool and stop casting
// every `task.foo as { ... }` site (the #1 unsafe-as pattern + #2 unknown
// without narrowing from the TS + React rubric).
//
// Convention: `gid` and `name` are always string per Asana's contract (even
// on compact resources); only fields Asana genuinely omits for some opt_fields
// projections are marked optional.
export interface AsanaRef {
  gid: string;
  name?: string;
  resource_type?: string;
}

export interface AsanaUserCompact {
  gid: string;
  name?: string;
}

export interface AsanaTaskCompact {
  gid: string;
  name?: string;
  completed?: boolean;
  completed_at?: string | null;
  due_on?: string | null;
  due_at?: string | null;
  start_on?: string | null;
  created_at?: string;
  modified_at?: string;
  notes?: string;
  assignee?: AsanaUserCompact | null;
  projects?: AsanaRef[];
  tags?: AsanaRef[];
  followers?: AsanaUserCompact[];
  custom_fields?: Array<{
    gid?: string;
    name?: string;
    display_value?: string | null;
  }>;
  memberships?: Array<{
    project?: AsanaRef;
    section?: { gid: string; name?: string };
  }>;
  subtasks?: Array<{
    gid: string;
    name?: string;
    completed?: boolean;
    completed_at?: string | null;
    assignee?: AsanaUserCompact | null;
  }>;
  parent?: AsanaRef | null;
  dependencies?: AsanaRef[];
  dependents?: AsanaRef[];
  permalink_url?: string;
}

// A custom field value on a task. `resource_subtype`/`type` is one of "text",
// "number", or "enum". For enum fields the current value is `enum_value` and
// the legal choices live in `enum_options`; for text/number the value is in
// `text_value`/`number_value`. `display_value` is Asana's human rendering.
export interface AsanaCustomFieldEnumOption {
  gid: string;
  name?: string;
  enabled?: boolean;
  color?: string;
}

export interface AsanaCustomField {
  gid: string;
  name?: string;
  resource_subtype?: string; // "text" | "number" | "enum"
  type?: string; // mirrors resource_subtype on task projections
  enabled?: boolean;
  description?: string;
  text_value?: string | null;
  number_value?: number | null;
  enum_value?: AsanaCustomFieldEnumOption | null;
  display_value?: string | null;
  enum_options?: AsanaCustomFieldEnumOption[];
  precision?: number;
  format?: string;
  currency_code?: string | null;
}

export interface AsanaProjectStatus {
  gid: string;
  title?: string;
  text?: string;
  color?: string;
  author?: AsanaUserCompact;
  created_at?: string;
}

export interface AsanaProjectCompact {
  gid: string;
  name?: string;
  notes?: string;
  archived?: boolean;
  layout?: string;
  default_view?: string;
  owner?: AsanaUserCompact | null;
  members?: AsanaUserCompact[];
  current_status?: {
    gid: string;
    title?: string;
    color?: string;
  } | null;
  sections?: AsanaRef[];
  task_counts?: {
    completed?: number;
    incomplete?: number;
  };
}

export interface AsanaUser {
  gid: string;
  name?: string;
  email?: string;
  resource_type?: string;
  workspaces?: AsanaRef[];
}

// Asana attachment (file/image/etc.) on a task. `host` decides whether we can
// auto-download: "asana" attachments carry a live `download_url` (S3 presigned,
// ~2 min TTL, must be fetched WITHOUT the Bearer token); external hosts
// (gdrive/dropbox/box/onedrive/...) leave `download_url` null and only expose
// a browser `view_url` we hand back to the agent.
export interface AsanaAttachment {
  gid: string;
  resource_type?: string;
  // Always "file" for Asana-hosted uploads today, but kept string for safety.
  resource_subtype?: string;
  name?: string;
  // "asana" | "external" | "dropbox" | "gdrive" | "box" | "onedrive" | ...
  host?: string;
  // Temporary S3 URL when host=asana; null/empty for external hosts.
  download_url?: string | null;
  // Browser-friendly link; always present. The only link we can return for
  // external-host attachments.
  view_url?: string;
  size?: number | null;
  created_at?: string;
  created_by?: AsanaUserCompact | null;
  parent?: AsanaRef | null;
}

export interface AsanaStory {
  gid: string;
  created_at?: string;
  // `type` is the human-vs-system discriminator for stories: "comment" for
  // user comments, "system" for status changes / assignment logs / etc.
  // `resource_subtype` describes the action (e.g. "comment_added",
  // "assigned", "description_changed") and is NOT a reliable discriminator.
  // Caught during live testing: a filter on resource_subtype === "comment"
  // returned 0/50 stories on a task that the user knew had comments.
  type?: "comment" | "system" | string;
  resource_subtype?: string;
  text?: string;
  html_text?: string;
  created_by?: AsanaUserCompact | null;
  // True only for comments the authenticated user (PAT owner) can edit.
  // System stories and other people's comments return false; PUT /stories on
  // them fails. https://developers.asana.com/reference/updatestory
  is_editable?: boolean;
}
