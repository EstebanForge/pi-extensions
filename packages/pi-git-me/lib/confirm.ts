// Human-in-the-loop gate for git-me write tools.
//
// The agent drafts the text (commit message, PR body, review comment); this
// gate lets a human SEE it (and EDIT it) before anything reaches git, gh, or
// the PR review. Two paths:
//
//   editableText set       -> editor(): review + edit + accept/cancel
//   otherwise              -> confirm(): yes/no on a readable summary
//
// Prose tools (commit message, PR description, review comment) use the editable
// path because that is where models over-explain or misjudge tone. A forced
// path (`requireInteractive`) skips the flag and demands a yes/no regardless,
// and blocks headless mode entirely.
//
// PERSISTENCE: pi's extension flags (pi.registerFlag) are in-memory only, seeded
// from `default` and CLI `--flag-name` args at process start. There is no
// setFlag on ExtensionAPI and `pi config set <flag>` does NOT touch flags. So
// we own a tiny settings file at <piDir>/pi-git-me.json
// ({ confirmWrite: bool, allowHeadlessWrite: bool }), hydrate from it on read,
// and write through on toggle. `piDir` =
// process.env.PI_CODING_AGENT_DIR || ~/.pi/agent.
//
// The gate takes no ExtensionAPI on purpose: it never calls pi.getFlag (flags
// are in-memory only), so closing over `pi` would be dead weight. All write
// tools therefore stay flat consts (no factory), which keeps the tool set
// uniform with the read tools.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Name of the persisted boolean flag that toggles the gate for prose writes. */
export const CONFIRM_WRITE_FLAG = "git-confirm-write";

export const CONFIRM_WRITE_FLAG_DESCRIPTION =
  "When on (default), the eight write tools (git_commit, git_pr_upsert, git_pr_comment, git_pr_review, git_issue_comment, git_issue_create, git_discussion_create, git_discussion_comment) open an editable preview before touching git or GitHub. Turn off to apply without confirmation. APPROVE / REQUEST_CHANGES are always confirmed regardless of this setting. Toggle via /git config or /git confirm on|off.";

/**
 * Name of the persisted boolean flag that allows prose writes to run in
 * HEADLESS mode (no interactive UI). Default OFF: an unsupervised run cannot
 * commit, edit a PR, or post a review comment on your behalf until you opt in.
 */
export const ALLOW_HEADLESS_WRITE_FLAG = "git-allow-headless-write";

export const ALLOW_HEADLESS_WRITE_FLAG_DESCRIPTION =
  "When on (default off), the prose write tools (git_commit, git_pr_upsert, git_pr_comment, git_issue_comment, git_issue_create, git_discussion_create, git_discussion_comment, and git_pr_review COMMENT) MAY run in headless mode (no interactive UI) without a human review. Off by default: unsupervised writes are refused until a human is present at the UI. APPROVE / REQUEST_CHANGES are always blocked in headless mode (no opt-in). Toggle via /git config or /git headless on|off.";

const SETTINGS_FILENAME = "pi-git-me.json";
const DEFAULT_CONFIRM_WRITE = true;
const DEFAULT_ALLOW_HEADLESS_WRITE = false;

// Resolve the agent config dir the same way pi does (dist/config.js getAgentDir):
// env override wins, else ~/.pi/agent. Exported so tests can point it elsewhere.
export function getPiDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;
  return join(homedir(), ".pi", "agent");
}

export function getSettingsPath(): string {
  return join(getPiDir(), SETTINGS_FILENAME);
}

interface SettingsFile {
  confirmWrite?: unknown;
  allowHeadlessWrite?: unknown;
}

// Reads happen only on the write-tool path (rare, user-gated), so we read from
// disk each call rather than cache. This avoids stale-cache bugs across
// toggle/reload and makes tests deterministic without a reset hook. Setters do
// a read-merge-write so toggling one flag never clobbers the other.

function readSettings(): SettingsFile {
  try {
    const path = getSettingsPath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as SettingsFile;
  } catch {
    // Corrupt / unreadable file -> treat as empty (each flag falls back to its
    // own safe default below).
    return {};
  }
}

function writeSettings(patch: Partial<SettingsFile>): boolean {
  const dir = getPiDir();
  const path = join(dir, SETTINGS_FILENAME);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const next = { ...readSettings(), ...patch };
    const payload = JSON.stringify(next, null, 2) + "\n";
    // Atomic write: stage to a temp file in the same directory, then rename.
    // A crash mid-write cannot leave a truncated/empty settings file (which
    // readSettings would silently reset to the safe defaults).
    const tmp = join(dir, `.${SETTINGS_FILENAME}.${process.pid}.tmp`);
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Current live value of the review gate (read from disk each call). */
export function getConfirmWriteEnabled(): boolean {
  // Only an explicit literal false disables; anything else -> default ON.
  return readSettings().confirmWrite === false ? false : DEFAULT_CONFIRM_WRITE;
}

/** Current live value of the headless-write opt-in (read from disk each call). */
export function getAllowHeadlessWriteEnabled(): boolean {
  // Only an explicit literal true enables; anything else -> default OFF (safe).
  return readSettings().allowHeadlessWrite === true;
}

/** Persist the review-gate value. Read-merge-write; does not clobber the headless flag. */
export function setConfirmWriteEnabled(value: boolean): boolean {
  return writeSettings({ confirmWrite: value });
}

/** Persist the headless-write opt-in value. Read-merge-write; does not clobber the review flag. */
export function setAllowHeadlessWriteEnabled(value: boolean): boolean {
  return writeSettings({ allowHeadlessWrite: value });
}

// Structural slice of the context that the gate touches. Minimal on purpose so
// the helper is trivial to mock in tests.
export interface ConfirmContext {
  hasUI: boolean;
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
  };
}

export interface ConfirmWriteOptions {
  /** Title for the review dialog. */
  title: string;
  /**
   * Optional editable text. When set, an editor() opens (review + edit +
   * accept/cancel) and the returned text may differ from the input. When
   * omitted, a yes/no confirm() on `summary` is shown instead.
   */
  editableText?: string;
  /** Readable payload preview, shown by confirm() in the non-editable path. */
  summary: string;
  /**
   * Optional normalizer applied to BOTH the editor return and the prefill
   * before the `edited` flag is computed. Pass the same transformation the
   * tool applies just before transmission (e.g. `(s) => s.trimEnd()`), so a
   * whitespace-only edit that is stripped before sending does NOT count as
   * edited. Default is the identity function.
   */
  normalize?: (text: string) => string;
  /**
   * Force the gate regardless of the review flag, AND block when no interactive
   * UI is available. Use for irreversible/destructive writes (force-push, PR
   * close, etc.). A forced write is ALWAYS blocked in headless mode (no
   * opt-in); a non-forced write in headless mode is blocked unless the
   * git-allow-headless-write opt-in is on.
   */
  requireInteractive?: boolean;
}

export interface ConfirmOutcome {
  proceed: boolean;
  /** Final text to apply. Equals the (possibly edited) text in the editable path. */
  text?: string;
  /**
   * True when the human changed the agent's draft in the review dialog. Lets a
   * write tool tell the agent its original wording was NOT what shipped. Only
   * meaningful when `proceed` is true; unset on cancel/refuse paths.
   */
  edited?: boolean;
}

// DIALOG SERIALIZATION: pi's interactive UI shows one extension dialog at a
// time, and an overlapping ctx.ui.confirm/editor call REPLACES the live
// dialog without settling the replaced promise. With parallel gated tool
// calls (e.g. three git_commit calls in one batch) the first prompt renders,
// the rest never do, and their tool calls hang until the run is cancelled.
// Fix on our side: hold a process-wide FIFO lock only while a dialog is open.
// The lock is keyed via Symbol.for because all pi-*-me extensions run in the
// SAME pi process; a per-module lock would still let a git_commit dialog and
// a slack_post_message dialog from one parallel batch clobber each other.
const DIALOG_LOCK: unique symbol = Symbol.for("pi-me.dialog-lock");

interface DialogQueue {
  tail: Promise<void>;
}

function dialogQueue(): DialogQueue {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[DIALOG_LOCK] as DialogQueue | undefined;
  if (existing) return existing;
  const created: DialogQueue = { tail: Promise.resolve() };
  host[DIALOG_LOCK] = created;
  return created;
}

/**
 * Run `run` while holding the cross-extension dialog lock. FIFO: each caller
 * chains onto the queue tail synchronously (before its first await), so call
 * order is the order the dialogs appear. Released in a finally block, so one
 * throwing dialog can never wedge the queue for the callers behind it.
 */
export async function withDialogLock<T>(run: () => Promise<T>): Promise<T> {
  const queue = dialogQueue();
  const prev = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await run();
  } finally {
    release();
  }
}

/**
 * Resolve whether a write should proceed, prompting the user when the gate is
 * active and an interactive UI is present. Pure orchestration: no git/gh I/O.
 *
 * Two independent gates, evaluated in order:
 *   1. HEADLESS guard — without an interactive UI, writes are blocked unless
 *      git-allow-headless-write is on. Destructive (forced) writes are ALWAYS
 *      blocked headless, no opt-in. This guard is independent of the review
 *      flag: even with git-confirm-write OFF, an unsupervised run cannot
 *      commit or edit a PR on your behalf unless you allow it.
 *   2. REVIEW gate — with a UI present, prose writes open an editable preview
 *      (skipped when git-confirm-write is off); forced writes always need
 *      yes/no.
 */
export async function confirmWrite(
  ctx: ConfirmContext,
  opts: ConfirmWriteOptions,
): Promise<ConfirmOutcome> {
  const forced = opts.requireInteractive === true;

  // 1. HEADLESS GUARD (independent of the review flag). Applies to every write
  //    before any review logic.
  if (!ctx.hasUI) {
    // Destructive writes can never be confirmed blind -> always refuse.
    if (forced) return { proceed: false };
    // Non-destructive writes need the explicit headless opt-in to proceed.
    if (!getAllowHeadlessWriteEnabled()) return { proceed: false };
    // No human reviewed this, so the draft cannot have been edited.
    return { proceed: true, text: opts.editableText, edited: false };
  }

  // 2. REVIEW gate (interactive UI present). Forced writes ignore the flag
  //    (they always need a human yes/no). Non-forced writes skip the review
  //    entirely when git-confirm-write is off.
  if (!forced && !getConfirmWriteEnabled()) {
    // Gate off: the dialog never opened, so the draft is unchanged.
    return { proceed: true, text: opts.editableText, edited: false };
  }

  // One dialog at a time (see withDialogLock): parallel gated calls queue up
  // and each prompt is shown in turn instead of clobbering the live dialog.
  if (opts.editableText !== undefined) {
    // Capture the draft so the narrowing survives inside the closure (TS
    // will not carry the `!== undefined` check across the function boundary).
    const draft = opts.editableText;
    return withDialogLock(async () => {
      const edited = await ctx.ui.editor(opts.title, draft);
      if (edited === undefined) return { proceed: false };
      const norm = opts.normalize ?? ((s: string) => s);
      return {
        proceed: true,
        text: edited,
        // Compare AFTER the same normalization the tool applies before sending,
        // so a whitespace-only edit that gets trimmed away does not register as
        // "edited" (which would falsely tell the agent its draft was changed).
        edited: norm(edited) !== norm(draft),
      };
    });
  }

  const ok = await withDialogLock(() =>
    ctx.ui.confirm(opts.title, opts.summary),
  );
  return { proceed: ok };
}
