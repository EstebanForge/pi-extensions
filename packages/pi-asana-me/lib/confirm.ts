// Human-in-the-loop gate for Asana write tools.
//
// The agent drafts the Asana payload; this gate lets a human SEE it (and, for
// comments, EDIT it) before any POST/PUT reaches the Asana REST API. Driven by
// a persisted boolean (default on) and gated on `ctx.hasUI`:
//
//   review disabled       -> no gate, proceed
//   no interactive UI      -> cannot prompt; proceed (never block headless writes)
//   editableText set       -> ctx.ui.editor(): review + edit + accept/cancel
//   otherwise              -> ctx.ui.confirm(): yes/no on a readable summary
//
// Comments use the editable path (prose is where models over-explain). Task
// batches use the confirm path (structured payloads are not safe to hand-edit
// in a generic text box).
//
// PERSISTENCE: pi's extension flags (pi.registerFlag) are in-memory only, seeded
// from `default` and CLI `--flag-name` args at process start. There is no
// setFlag on ExtensionAPI and `pi config set <flag>` does NOT touch flags. So we
// own a tiny settings file at <piDir>/pi-asana-me.json ({ confirmWrite: bool }),
// hydrate module-level state from it at load, and write through on toggle. This
// keeps the value live across the session without a reload, and durable across
// restarts. `piDir` = process.env.PI_CODING_AGENT_DIR || ~/.pi/agent.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fmtTask, type ResolvedRef } from "./resolve";

/** Name of the persisted boolean flag that toggles the whole gate. */
export const CONFIRM_WRITE_FLAG = "asana-confirm-write";

export const CONFIRM_WRITE_FLAG_DESCRIPTION =
  "When on (default), asana_add_comment / asana_create_tasks / asana_update_tasks prompt for review before posting to Asana. Comments open an editable preview; task batches ask yes/no. Turn off to post without confirmation. Toggle via /asana config or /asana confirm on|off.";

const SETTINGS_FILENAME = "pi-asana-me.json";
const DEFAULT_CONFIRM_WRITE = true;

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
}

// The settings file is tiny and reads happen only on the write-tool path
// (rare, user-gated), so we read from disk each call rather than cache. This
// avoids stale-cache bugs across toggle/reload and makes tests deterministic
// without a reset hook. setConfirmWriteEnabled writes through and the next
// read reflects it immediately.

function loadFromDisk(): boolean {
  try {
    const path = getSettingsPath();
    if (!existsSync(path)) return DEFAULT_CONFIRM_WRITE;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SettingsFile;
    // Only an explicit literal false disables the gate; anything else (true,
    // missing, wrong type) falls back to the safe default (ON).
    return parsed.confirmWrite === false ? false : DEFAULT_CONFIRM_WRITE;
  } catch {
    // Corrupt / unreadable file -> fall back to the safe default (gate ON).
    return DEFAULT_CONFIRM_WRITE;
  }
}

/** Current live value of the gate (read from disk each call). */
export function getConfirmWriteEnabled(): boolean {
  return loadFromDisk();
}

/**
 * True when the gate would actually show a prompt (gate on AND interactive UI).
 * Lets write tools skip best-effort GID resolution (extra API calls) on the
 * headless / gate-off fast paths, where no human ever sees the summary.
 * Mirrors the two short-circuit checks inside confirmWrite, against the same
 * source of truth (file-backed gate + ctx.hasUI).
 */
export function willPromptForWrite(ctx: { hasUI: boolean }): boolean {
  return getConfirmWriteEnabled() && ctx.hasUI;
}

/**
 * Persist + apply a new gate value. Writes through to <piDir>/pi-asana-me.json and
 * updates live state synchronously, so the next write-tool call sees the new
 * value immediately (no reload required). Returns true on success.
 */
export function setConfirmWriteEnabled(value: boolean): boolean {
  const dir = getPiDir();
  const path = join(dir, SETTINGS_FILENAME);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Atomic write: stage to a temp file in the same directory, then rename.
    // A crash mid-write cannot leave a truncated/empty settings file (which
    // would silently reset the gate to its default on the next read).
    const tmp = join(dir, `.${SETTINGS_FILENAME}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ confirmWrite: value }, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    // Disk write failed (permissions, read-only fs). The next read still
    // reflects whatever is on disk, so the session keeps working.
    return false;
  }
}

// Structural slice of ExtensionContext that confirmWrite touches. Keeping it
// minimal decouples the helper from the full context type and makes it trivial
// to mock in tests.
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
   * tool applies just before transmission, so a whitespace-only edit that is
   * stripped before sending does NOT count as edited. Default is identity.
   */
  normalize?: (text: string) => string;
}

export interface ConfirmOutcome {
  proceed: boolean;
  /** Final text to send. Equals the (possibly edited) text in the editable path. */
  text?: string;
  /**
   * True when the human changed the agent's draft in the review dialog. Lets a
   * write tool tell the agent its original wording was NOT what shipped. Only
   * meaningful when `proceed` is true; unset on cancel/refuse paths.
   */
  edited?: boolean;
}

/**
 * Resolve whether a write should proceed, prompting the user when the gate is
 * active and an interactive UI is present. Pure orchestration: no Asana I/O.
 *
 * The gate takes no ExtensionAPI on purpose: it never calls pi.getFlag (flags
 * are in-memory only), so closing over `pi` would be dead weight. It reads its
 * own file-backed module state instead. The asana-confirm-write flag is still
 * registered for /settings visibility and CLI `--asana-confirm-write` override.
 */
// DIALOG SERIALIZATION: pi's interactive UI shows one extension dialog at a
// time, and an overlapping ctx.ui.confirm/editor call REPLACES the live
// dialog without settling the replaced promise. With parallel gated tool
// calls (e.g. three asana_add_comment calls in one batch) the first prompt
// renders, the rest never do, and their tool calls hang until the run is
// cancelled. Fix on our side: hold a process-wide FIFO lock only while a
// dialog is open. The lock is keyed via Symbol.for because all pi-*-me
// extensions run in the SAME pi process; a per-module lock would still let an
// asana_add_comment dialog and a git_commit dialog from one parallel batch
// clobber each other.
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

export async function confirmWrite(
  ctx: ConfirmContext,
  opts: ConfirmWriteOptions,
): Promise<ConfirmOutcome> {
  if (!getConfirmWriteEnabled()) {
    return { proceed: true, text: opts.editableText, edited: false };
  }
  // No interactive UI (headless / RPC without dialogs) -> cannot prompt;
  // proceed rather than deadlocking an unsupervised run.
  if (!ctx.hasUI) {
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
        edited: norm(edited) !== norm(draft),
      };
    });
  }

  const ok = await withDialogLock(() =>
    ctx.ui.confirm(opts.title, opts.summary),
  );
  return { proceed: ok };
}

// Readable summaries for the confirm() path. Capped so a 50-item batch does
// not overflow the dialog.

const PREVIEW_CAP = 10;

function firstProject(t: { project?: string; projects?: string[] }): string | undefined {
  if (t.project !== undefined) return t.project;
  if (Array.isArray(t.projects) && t.projects.length > 0) return t.projects[0];
  return undefined;
}

export function summarizeCreateTasks(
  workspace: string | undefined,
  tasks: Array<{
    name?: string;
    notes?: string;
    assignee?: string;
    due_on?: string;
    project?: string;
    projects?: string[];
    section?: string;
    parent?: string;
  }>,
  resolved?: Map<string, ResolvedRef>,
): string {
  const lines: string[] = [];
  if (workspace) lines.push(`workspace: ${workspace}`);
  lines.push(`tasks (${tasks.length}):`);
  const shown = tasks.slice(0, PREVIEW_CAP);
  shown.forEach((t, i) => {
    const parts: string[] = [t.name ?? "(untitled)"];
    const project = firstProject(t);
    if (project !== undefined) parts.push(`project=${project}`);
    if (t.section !== undefined) parts.push(`section=${t.section}`);
    if (t.parent !== undefined)
      parts.push(`parent=${fmtTask(t.parent, resolved?.get(t.parent))}`);
    if (t.assignee !== undefined) parts.push(`assignee=${t.assignee}`);
    if (t.due_on !== undefined) parts.push(`due=${t.due_on}`);
    lines.push(`  ${i + 1}. ${parts.join("  |  ")}`);
  });
  if (tasks.length > PREVIEW_CAP) lines.push(`  ...and ${tasks.length - PREVIEW_CAP} more`);
  return lines.join("\n");
}

export function summarizeUpdateTasks(
  tasks: Array<{
    gid: string;
    name?: string;
    notes?: string;
    completed?: boolean;
    assignee?: string;
    due_on?: string;
    section?: string;
    parent?: string;
    projects?: string[];
  }>,
  resolved?: Map<string, ResolvedRef>,
): string {
  const lines: string[] = [`updates (${tasks.length}):`];
  const shown = tasks.slice(0, PREVIEW_CAP);
  shown.forEach((t, i) => {
    const parts: string[] = [fmtTask(t.gid, resolved?.get(t.gid))];
    if (t.name !== undefined) parts.push(`name="${t.name}"`);
    if (t.completed !== undefined) parts.push(t.completed ? "complete" : "reopen");
    if (t.assignee !== undefined) parts.push(`assignee=${t.assignee}`);
    if (t.due_on !== undefined) parts.push(`due=${t.due_on}`);
    if (t.section !== undefined) parts.push(`section=${t.section}`);
    if (t.parent !== undefined)
      parts.push(`parent=${fmtTask(t.parent, resolved?.get(t.parent))}`);
    if (t.projects !== undefined) parts.push(`projects=${t.projects.join(",")}`);
    lines.push(`  ${i + 1}. ${parts.join("  |  ")}`);
  });
  if (tasks.length > PREVIEW_CAP) lines.push(`  ...and ${tasks.length - PREVIEW_CAP} more`);
  return lines.join("\n");
}
