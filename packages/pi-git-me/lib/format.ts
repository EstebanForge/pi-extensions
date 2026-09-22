// Formatting helpers shared across tools. These turn verbose raw outputs
// into the short, readable strings the confirm() / editor() dialogs render.

const PREVIEW_CAP = 240;

/** Collapse whitespace and cap length. Used in confirm() summaries. */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CAP ? `${flat.slice(0, PREVIEW_CAP)}...` : flat;
}

/** Format a commit message as "subject\n\nbody". Empty/missing body -> just the subject. */
export function formatCommitMessage(subject: string, body?: string): string {
  const s = subject.trim();
  const b = (body ?? "").trim();
  if (!b) return s;
  return `${s}\n\n${b}`;
}

/**
 * Title+body in ONE editor buffer. Shared by every write tool that edits two
 * fields in a single dialog (PR title+body, issue title+body, discussion
 * title+body). The separator is a horizontal rule on its own blank-line
 * island: visually distinct in the editor, unlikely in user-typed content.
 * If a user pastes it verbatim we accept the ambiguity over adding extra
 * round-trips.
 */
const TITLE_BODY_SEP = "\n\n---\n\n";

/** Join a title and body into the single editor prefill buffer. */
export function toTitleBodyPrefill(title: string, body: string): string {
  return `${title.trim()}${TITLE_BODY_SEP}${body}`;
}

/**
 * Split an editor buffer back into { title, body }. When the user deleted
 * the separator, treat the whole buffer as the body and keep the
 * agent-supplied fallbackTitle, so the write does NOT hard-fail after the
 * user already accepted. (If they also blanked the original title param,
 * the !title guard in the caller still catches it.)
 */
export function fromTitleBodyPrefill(
  text: string,
  fallbackTitle: string,
): { title: string; body: string } {
  const idx = text.indexOf(TITLE_BODY_SEP);
  if (idx === -1) {
    return { title: fallbackTitle.trim(), body: text.trim() };
  }
  return {
    title: text.slice(0, idx).trim(),
    body: text.slice(idx + TITLE_BODY_SEP.length).trim(),
  };
}

/** Render the title + body block the agent and confirm() will show. */
export function describeTitleBodyPayload(title: string, body: string): string {
  return `title: ${oneLine(title)}\n\nbody:\n${oneLine(body)}`;
}

/** Render the review body the confirm() dialog will show. */
export function describeReviewPayload(body: string): string {
  return oneLine(body);
}

/**
 * Repo-context label for a confirm() / editor() dialog title. Returns a short
 * " (repo: <path>)" suffix ONLY when the tool targets a repository other than
 * the session default (ctx.cwd). The whole point of the review gate is that
 * the human knows WHICH repo a write will touch; without this, an agent that
 * passes cwd="/other/repo" could redirect a commit / PR / comment and the
 * dialog would not show it. When cwd === defaultCwd the title is already
 * accurate (it is the session repo), so no suffix is added.
 */
export function repoContextLabel(
  effectiveCwd: string | undefined,
  defaultCwd: string | undefined,
): string {
  if (!effectiveCwd || !defaultCwd || effectiveCwd === defaultCwd) return "";
  return ` (repo: ${effectiveCwd})`;
}

