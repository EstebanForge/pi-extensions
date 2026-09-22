// Tool titles, descriptions, and per-parameter descriptions. Written so the pi
// agent knows exactly WHEN to reach for each tool and what the parameters map
// to. The user-token (act-as-me) model is reflected throughout: no bot, no
// /invite, reads see exactly what the calling user sees.

// -------------------------------------------------- list channels ---------

export const LIST_CHANNELS_TITLE = "Slack: List Conversations";

export const LIST_CHANNELS_DESCRIPTION = `List Slack conversations the calling user can see (channels, DMs, and group DMs). Uses a user token, so this returns exactly what YOU see as a member - public channels, private channels you are in, your DMs and group DMs. No bot needs to be invited. Use this FIRST to resolve a channel/DM name to its ID before reading messages.`;

export const LIST_CHANNELS_LIMIT_DESCRIPTION =
  "Max conversations to return (1-999). Default 200.";

export const LIST_CHANNELS_TYPES_DESCRIPTION =
  'Comma-separated types. Default "public_channel,private_channel,im,mpim". Narrow to e.g. "im" to list only DMs.';

export const LIST_CHANNELS_CURSOR_DESCRIPTION =
  "Pagination cursor from a previous response's next_cursor.";

// -------------------------------------------------- read messages ---------

export const READ_MESSAGES_TITLE = "Slack: Read Messages";

export const READ_MESSAGES_DESCRIPTION = `Read message history from a Slack channel or DM. Returns recent messages with timestamps, authors, reactions, and file attachments. Uses a user token so you can read any conversation you are a member of - no bot invite needed. Channel IDs look like C0123ABC456; DM IDs look like D0123....`;

export const READ_MESSAGES_CHANNEL_DESCRIPTION =
  "Channel ID (C...), private channel ID, DM ID (D...), or group DM ID. Get it from slack_list_channels.";

export const READ_MESSAGES_LIMIT_DESCRIPTION =
  "Max messages to return (1-200). Default 50.";

export const READ_MESSAGES_OLDEST_DESCRIPTION =
  'Only messages at or after this Unix timestamp (e.g. 1512085950.000216). Inclusive: a message whose ts equals this value IS returned. Use for "since last read" windows or to fetch a specific message by its ts.';

export const READ_MESSAGES_LATEST_DESCRIPTION =
  "Only messages at or before this Unix timestamp. Inclusive: a message whose ts equals this value IS returned.";

export const READ_MESSAGES_CURSOR_DESCRIPTION =
  "Pagination cursor from a previous response's next_cursor.";

// -------------------------------------------------- read thread -----------

export const READ_THREAD_TITLE = "Slack: Read Thread";

export const READ_THREAD_DESCRIPTION = `Read all replies in a Slack thread. Provide the channel ID and the thread parent's timestamp (thread_ts). Uses a user token. The parent message is included as the first entry.`;

export const READ_THREAD_CHANNEL_DESCRIPTION =
  "Channel ID where the thread lives.";

export const READ_THREAD_TS_DESCRIPTION =
  "Timestamp of the parent message (thread_ts). Find it in a message's ts field.";

export const READ_THREAD_LIMIT_DESCRIPTION =
  "Max replies to return (1-1000). Default 100.";

export const READ_THREAD_CURSOR_DESCRIPTION =
  "Pagination cursor from a previous response's next_cursor.";

// -------------------------------------------------- search ----------------

export const SEARCH_TITLE = "Slack: Search Messages";

export const SEARCH_DESCRIPTION = `Full-text search across the workspace's messages. Supports Slack search syntax: in:#channel, from:@user, has:link, after:YYYY-MM-DD, before:YYYY-MM-DD, "exact phrase". Requires the user token to have search:read. Use to find feedback, issues, or past decisions across channels you can see.`;

export const SEARCH_QUERY_DESCRIPTION =
  'Search query. Examples: "broken deploy in:#ops", "from:@alice feedback after:2026-06-01".';

export const SEARCH_COUNT_DESCRIPTION =
  "Number of results (1-100). Default 20.";

export const SEARCH_SORT_DESCRIPTION =
  'Sort by "timestamp" or "score". Default "timestamp".';

export const SEARCH_SORT_DIR_DESCRIPTION =
  'Sort direction: "desc" (newest/best first) or "asc". Default "desc".';

export const SEARCH_PAGE_DESCRIPTION =
  "Page number for pagination. Default 1.";

// -------------------------------------------------- download file ---------

export const DOWNLOAD_FILE_TITLE = "Slack: Download File";

export const DOWNLOAD_FILE_DESCRIPTION = `Download a file or image shared in Slack to a temp directory and return the local path. For images, use the \`read\` tool on the returned path to actually see it. Uses a user token so any file you can see is downloadable.`;

export const DOWNLOAD_FILE_ID_DESCRIPTION =
  "Slack file ID (F0123ABC456). Find it in a message's files array or via search.";

// -------------------------------------------------- post message ----------

export const POST_MESSAGE_TITLE = "Slack: Post Message";

export const POST_MESSAGE_DESCRIPTION = `Post a message to a Slack channel, group DM, or existing DM as the calling user. Posts as YOU (user token), not a bot. The message opens in an editable review dialog before sending when the slack-confirm-write flag is on (default): you can trim or rewrite the text, or cancel. Provide EITHER channel (a channel/DM/group ID) OR to_user (a user ID like U0123ABC456 to DM someone). Providing both is an error. Set thread_ts to post as a threaded reply instead of a top-level message. Attach local images with images (png/jpg/gif/webp/bmp/svg); the message then posts as one file-share message and needs the files:write scope. Note: posting to a channel needs the chat:write scope; DM-ing via to_user also needs im:write (for conversations.open).`;

export const POST_MESSAGE_CHANNEL_DESCRIPTION =
  "Channel ID (C...), private channel ID, DM ID (D...), or group DM ID. Get it from slack_list_channels. Omit if using to_user instead.";

export const POST_MESSAGE_TO_USER_DESCRIPTION =
  "User ID (U0123ABC456) to send a DM to. The extension resolves it to a DM channel via conversations.open, then posts. Omit if using channel instead. One of channel / to_user is required.";

export const POST_MESSAGE_TEXT_DESCRIPTION =
  "Message text. Slack mrkdwn is supported (*bold*, _italic_, \`code\`, >quote). The user reviews this in an editable dialog before it is sent.";

export const POST_MESSAGE_THREAD_TS_DESCRIPTION =
  "Timestamp of a parent message to reply in its thread instead of posting top-level. Find the parent's ts in a message's ts field.";

export const POST_MESSAGE_IMAGES_DESCRIPTION =
  "Local image file paths to attach (png, jpg, jpeg, gif, webp, bmp, svg). Each file uploads via the Slack upload API and the message posts as one file-share message with the text as its comment. Requires the files:write scope.";

// -------------------------------------------------- update message --------

export const UPDATE_MESSAGE_TITLE = "Slack: Update Message";

export const UPDATE_MESSAGE_DESCRIPTION = `Edit the text of a message YOU previously posted. Posts as YOU (user token): only your own messages can be edited. The new text opens in an editable review dialog before sending when the slack-confirm-write flag is on (default). Requires the channel ID and the message ts (both come from slack_read_messages / slack_read_thread / slack_search).`;

export const UPDATE_MESSAGE_CHANNEL_DESCRIPTION =
  "Channel ID where the message lives. Get it from slack_list_channels or the message's channel field.";

export const UPDATE_MESSAGE_TS_DESCRIPTION =
  "Timestamp of the message to edit. Find it in a message's ts field.";

export const UPDATE_MESSAGE_TEXT_DESCRIPTION =
  "New message text (replaces the old text). Slack mrkdwn is supported. The user reviews this in an editable dialog before it is applied.";

// -------------------------------------------------- delete message --------

export const DELETE_MESSAGE_TITLE = "Slack: Delete Message";

export const DELETE_MESSAGE_DESCRIPTION = `Permanently delete a message as the calling user. ALWAYS asks for yes/no confirmation - even when slack-confirm-write is off, and even blocks in headless mode - because Slack deletes are irreversible. Requires the channel ID and the message ts. With a user token you can only delete your own messages.`;

export const DELETE_MESSAGE_CHANNEL_DESCRIPTION =
  "Channel ID where the message lives.";

export const DELETE_MESSAGE_TS_DESCRIPTION =
  "Timestamp of the message to delete. Find it in a message's ts field.";
