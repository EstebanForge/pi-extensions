# @estebanforge/pi-slack-me

Slack tools for [pi](https://github.com/earendil-works/pi-coding-agent) that act as **you**, not as a bot.

The extension adds 8 LLM-callable tools that read and write Slack using a **user token** (`xoxp-`). There is no bot to invite into channels and no visible footprint in the workspace: the Slack app inherits *your* membership and access, so the agent sees (and posts as) exactly what you do - public channels, private channels you're in, your DMs, and group DMs.

Use it when you want an agent to **consume information** from Slack (read feedback, follow issues, search past decisions, pull a thread into a coding session) **or post on your behalf** (send a message, reply in a thread, DM someone, edit or delete your own messages). Every write opens in a review dialog before it touches Slack, so nothing is sent or deleted without your say-so.

## Why a user token (and not a bot)

A bot token (`xoxb-`) can only read channels the bot has been explicitly invited to, and it can never read your DMs. That forces a visible new member into every channel you care about. A **user token** (`xoxp-`) speaks as your user, so the app reads anything your user can read, with no `/invite` step and no bot appearing anywhere. This is a fully supported Slack auth mode - every `*:history` scope lists `User` as a supported token type.

The tradeoff, per Slack's docs: the app shows an OAuth consent screen the first time you install it to the workspace, and workspaces requiring admin approval need an admin to approve it once. The app has **no bot user**, so it won't appear in member lists or channels - the only visible signal is in the workspace's Apps admin panel.

## Tools

| Tool | Description |
|------|-------------|
| `slack_list_channels` | List conversations you can see (channels, DMs, group DMs) via `users.conversations` |
| `slack_read_messages` | Read message history from a channel or DM (`conversations.history`) |
| `slack_read_thread` | Read all replies in a thread (`conversations.replies`) |
| `slack_search` | Full-text search across the workspace (`search.messages`) |
| `slack_download_file` | Download a shared file/image to a temp dir (`files.info` + download) |
| `slack_post_message` | Post a message to a channel, group DM, or existing DM as you; DM by user ID (`chat.postMessage` + `conversations.open`); attach local images with `images` (`files.getUploadURLExternal` + `files.completeUploadExternal`) |
| `slack_update_message` | Edit the text of a message you previously posted (`chat.update`) |
| `slack_delete_message` | Permanently delete one of your messages; always confirmed (`chat.delete`) |

User IDs are resolved to display names (cached), so feedback reads as `**Esteban**: ...` rather than `**U12345**: ...`.

## Write tools & review

The three write tools (`slack_post_message`, `slack_update_message`, `slack_delete_message`) post as **you**. A user token posts as your user natively - no `as_user` flag, no bot. You can only edit or delete messages you authored.

Before any write reaches Slack, the extension shows it for review:

- **post / update** open an **editable** dialog - trim or rewrite the text, then accept or cancel (Esc).
- **delete** asks **yes/no** - it is irreversible, so it is *always* confirmed even when the review flag is off, and it is **refused in headless mode** rather than running blind.

The editable review is on by default and is governed by the `slack-confirm-write` flag.

**Headless mode** (no interactive UI, e.g. an unsupervised/automated run): post and update are **refused by default** - the extension will not post on your behalf without a human present. Opt in with the `slack-allow-headless-write` flag if you genuinely want unsupervised writes (e.g. scheduled/automation use). Delete is *always* blocked in headless mode, no opt-in.

- `/slack config` - settings modal (TUI)
- `/slack confirm on` / `/slack confirm off` - toggle the editable review (delete stays guarded regardless)
- `/slack headless on` / `/slack headless off` - opt in/out of unsupervised (no-UI) writes

## Setup

### 1. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**. Give it a name (e.g. `pi-slack-me`) and select your workspace.

### 2. Add User Token Scopes

In the left sidebar → **OAuth & Permissions** → scroll to **User Token Scopes** (not Bot Token Scopes).

| Scope | Enables |
|-------|---------|
| `channels:read` | list public channels |
| `groups:read` | list private channels |
| `im:read` | list DMs |
| `mpim:read` | list group DMs |
| `channels:history` | read public channel messages |
| `groups:history` | read private channel messages |
| `im:history` | read your DMs |
| `mpim:history` | read group DMs |
| `users:read` | resolve user IDs to display names |
| `search:read` | `slack_search` (optional but recommended) |
| `files:read` | download shared files (`slack_download_file`) |
| `chat:write` | **post / update / delete messages as you** (`slack_post_message`, `slack_update_message`, `slack_delete_message`) |
| `im:write` | **DM someone via `to_user`** (`slack_post_message` opens the DM via `conversations.open`; not needed for posting to an existing channel/group DM) |
| `files:write` | **attach images via the `images` param** (`slack_post_message` uploads via `files.getUploadURLExternal` + `files.completeUploadExternal`; not needed for text-only posts) |

No Bot Token Scopes are needed. There is no bot.

> **Scope at a glance:** `chat:write` covers posting, editing, and deleting. Add `im:write` only if you use `to_user` (DM a user by ID). Add `files:write` only if you attach images. Reading needs the `*:read` / `*:history` scopes above.

#### Upgrading from a read-only install (v1.x)

If you installed before write support, your existing token lacks `chat:write` and write tools will return `missing_scope`. To add it:

1. [api.slack.com/apps](https://api.slack.com/apps) -> your app -> **OAuth & Permissions** -> **User Token Scopes**.
2. Add **`chat:write`** (post/update/delete) and, if you will use `to_user` to DM people, **`im:write`** (opens the DM).
3. **Save** changes, then click **Reinstall to {Workspace}** (Slack requires a reinstall for new scopes to take effect).
4. The User OAuth Token (`xoxp-...`) stays the same across reinstalls for standard apps - new scopes attach to the existing token, so `SLACK_USER_TOKEN` needs no update. If Slack ever shows a different value on that page, copy it and update the env var.

No `/invite` step is needed at any point.

#### Upgrading for image attachments (v1.2.0+)

`slack_post_message` accepts local image paths via the `images` param (png, jpg, jpeg, gif, webp, bmp, svg). That upload flow needs the **`files:write`** User Token Scope - text-only posts do not. To add it:

1. [api.slack.com/apps](https://api.slack.com/apps) -> your app -> **OAuth & Permissions** -> **User Token Scopes**.
2. Add **`files:write`**.
3. **Save**, then **Reinstall to {Workspace}**. The token value survives reinstalls (scopes attach to it), so `SLACK_USER_TOKEN` needs no update.

Image posts go out as one file-share message: the text travels as the message's comment, and `thread_ts` still threads the reply. Paths are checked (exists + supported type) before the review dialog opens.

### 3. Install to workspace

Still on **OAuth & Permissions** → click **Install to {Workspace-name}** → authorize. (If your workspace requires admin approval, an admin must approve it.) The consent screen reflects the user scopes above.

### 4. Copy the user token

After installing, the same page shows:

- **User OAuth Token** — starts with `xoxp-` → your `SLACK_USER_TOKEN`

```bash
export SLACK_USER_TOKEN=xoxp-...
```

### 5. Done

No `/invite` step. No bot in any channel. The token reads as your user.

## Install

```bash
pi install npm:@estebanforge/pi-slack-me
```

## Commands

| Command | Description |
|---|---|
| `/slack` | Show token status and usage |
| `/slack channels [types]` | List conversations (prefills `slack_list_channels`) |
| `/slack dms` | List your DMs (prefills `slack_list_channels` with `types=im`) |
| `/slack read <channel> [N]` | Read recent messages (prefills `slack_read_messages`) |
| `/slack thread <channel> <ts>` | Read a thread (prefills `slack_read_thread`) |
| `/slack search <query>` | Search messages (prefills `slack_search`) |
| `/slack post <channel> <text>` | Post a message (prefills `slack_post_message`) |
| `/slack dm <user> <text>` | DM a user by ID (prefills `slack_post_message` with `to_user`) |
| `/slack reply <channel> <ts> <text>` | Reply in a thread (prefills `slack_post_message` with `thread_ts`) |
| `/slack edit <channel> <ts> <text>` | Edit your message (prefills `slack_update_message`) |
| `/slack delete <channel> <ts>` | Delete your message (prefills `slack_delete_message`) |
| `/slack config` | Settings modal (write review gate) |
| `/slack confirm on\|off` | Toggle write review (delete stays guarded) |

## Notes

- **Session scope**: the user token grants workspace-wide read access as you. Treat it like any other credential - `0600` on any file it lands in, never commit it, rotate it if leaked.
- **Token rotation**: if Slack invalidates the token (e.g. you revoke the app or change your password), calls return `invalid_auth`. Re-install the app and update `SLACK_USER_TOKEN`.
- **Rate limits**: Slack returns `429` with a `Retry-After` header on rate limit; this extension surfaces the retry hint in the error text. Bulk reads (hundreds of channels) should page via the returned cursor. Writes (`chat.postMessage`) are limited to ~1/sec per channel - avoid tight-loop bulk posting.
- **DM author names**: DM message payloads carry the other user's ID; the extension resolves it via `users.info`. Your own messages show as your display name.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:watch
```

## License

MIT
