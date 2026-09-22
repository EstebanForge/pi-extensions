// Concrete Slack Web API response shapes, shared across tool and client files.
// IMPORTANT: Slack returns snake_case keys. These types mirror that exactly
// (no camelCase normalization), so callers read the raw field names Slack
// sends. Single-word keys (id, name, text, ts, user, topic, purpose, reactions,
// files, mimetype) are unchanged; multi-word ones stay snake_case.

// conversations.list / users.conversations channel object.
export interface SlackChannel {
  id: string;
  name: string;
  is_private?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  // im/mpim only: the other user (im) or nothing useful (mpim name is generated).
  user?: string;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

// conversations.history / conversations.replies message object.
export interface SlackMessage {
  user?: string;
  username?: string; // bot-authored messages
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; count: number }>;
  files?: Array<{
    id: string;
    name: string;
    mimetype?: string;
    filetype?: string;
    size?: number;
    url_private?: string;
    url_private_download?: string;
  }>;
}

// users.info object. display_name / real_name come from profile (snake_case).
export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
  };
}

// files.info object (snake_case, raw from Slack).
export interface SlackFileInfo {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
}

// search.messages match object.
export interface SlackSearchMatch {
  iid: string;
  team?: string;
  channel: { id: string; name?: string; is_channel?: boolean; is_group?: boolean };
  user?: string;
  username?: string;
  ts: string;
  text?: string;
  permalink: string;
}

// search.messages envelope.
export interface SlackSearchResult {
  matches: SlackSearchMatch[];
  total: number;
  paging?: { page?: number; pages?: number; count?: number; total?: number };
}
