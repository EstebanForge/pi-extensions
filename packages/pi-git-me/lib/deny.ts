// Shell-commit deny: word-level parser plus the tool_call blocker.
//
// Why a parser and not a regex: "git -C dir commit" must be denied while
// "git log -- commit" must pass. Global options like -C consume the next
// word, so any regex that allows options also false-positives on value
// position. Tokenizing and walking git's argv avoids that class entirely.
//
// Accepted limitations (static analysis of a dynamic shell): variable
// indirection ($GIT commit), eval, command substitution inside double
// quotes, and script-file indirection (heredoc bodies are scanned as plain
// lines, so creating a script that mentions git commit is blocked too -
// fail-closed). write_stdin is inspected per call, so split-byte input and
// stateful shell evasion are also outside scope. Deliberate multi-step
// evasion is itself a policy breach; this is a tripwire, not a sandbox.
//
// Why this exists: two recorded sessions (2026-09-16, 2026-10-01) contain
// shell `git commit -F -` bypasses of the commit tool's preview gate, the
// second after a no-recur promise. Prompt guidance alone demonstrably
// recurs; enforcement is opt-out (default ON) via the git-deny-shell-commit
// flag in lib/confirm.ts.

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { getDenyShellCommitEnabled } from "./confirm";

export const SHELL_COMMIT_BLOCK_REASON =
  "Shell git commit is blocked (git-deny-shell-commit is on). Use the git_commit tool instead: your draft goes through the editable preview dialog before anything touches git. Toggle: /git deny-commit off.";

const SHELL_TOOL_NAMES = ["bash", "exec_command", "write_stdin"] as const;
const WRAPPERS = new Set(["sudo", "command", "builtin", "noglob", "env"]);
// Wrappers that take their own flags before the command. Only value-taking
// flags are listed; boolean wrapper flags are skipped without a value.
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-T", "-t", "--user", "--group", "--host", "--prompt", "--chdir", "--config"]),
  env: new Set(["-u", "-C", "--chdir", "--unset"]),
};
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GROUPING = new Set(["(", ")", "{", "}"]);
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

// Command separators are only honored OUTSIDE quotes: "echo 'a; b'" is one
// command, and splitting it would tear a quoted "git commit" string into a
// fake command (false block). Backslash-newline is a line continuation, not
// a boundary.
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  const push = () => {
    segments.push(current);
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    // Single quotes are strictly literal: the backslash check below must NOT
    // run here, or `echo 'a\'; git commit` leaves the quote "open" forever
    // and swallows the real command (round-2 agy finding).
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        // Pair backslashes first: in "\\" the quote CLOSES (even count),
        // and treating the second backslash as escaping it would swallow
        // the next command separator (round-3 agy finding).
        if (command[i + 1] === "\\") {
          current += "\\\\";
          i++;
          continue;
        }
        if (command[i + 1] === '"') {
          current += '\\"';
          i++;
          continue;
        }
      }
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (escaped) {
      // Line continuation: drop backslash AND the newline (CRLF included).
      if (ch === "\r" && command[i + 1] === "\n") i++;
      if (ch === "\n" || ch === "\r") {
        escaped = false;
        continue;
      }
      // Keep the backslash: stripEnvAssignments/tokenize need to see \-escaped
      // spaces in values like VAR=John\ Doe (round-2 agy finding).
      current += "\\";
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      current += ch;
      if (ch === "'") inSingle = true;
      else inDouble = true;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      push();
      continue;
    }
    if (ch === "&" || ch === "|") {
      // & and | are command terminators; && and || collapse into one split.
      if (command[i + 1] === ch) i++;
      push();
      continue;
    }
    current += ch;
  }
  push();
  return segments;
}

function skipQuoted(command: string, start: number): number | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        if (i + 1 >= command.length) return null;
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= command.length) return null;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") return i;
  }
  return inSingle || inDouble ? null : command.length;
}

function stripEnvAssignments(segment: string): string | null {
  let rest = segment.trimStart();
  while (ENV_ASSIGNMENT.test(rest)) {
    const eq = rest.indexOf("=");
    const end = skipQuoted(rest, eq + 1);
    if (end === null) return null;
    if (end === rest.length) return "";
    rest = rest.slice(end).trimStart();
  }
  return rest;
}

export function stripAndTokenize(segment: string): string[] {
  const stripped = stripEnvAssignments(segment);
  if (stripped === null) return [];
  const words: string[] = [];
  let current = "";
  let hasCurrent = false;
  const push = () => {
    if (hasCurrent) {
      words.push(current);
      current = "";
      hasCurrent = false;
    }
  };
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < stripped.length) {
        current += stripped[++i];
        continue;
      }
      if (ch === '"') inDouble = false;
      else current += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasCurrent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasCurrent = true;
      continue;
    }
    if (ch === "\\" && i + 1 < stripped.length) {
      // Backslash-newline is a line continuation: it contributes no
      // character and must not glue into the next word.
      if (stripped[i + 1] === "\n" || stripped[i + 1] === "\r") {
        i++;
        continue;
      }
      current += stripped[++i];
      hasCurrent = true;
      continue;
    }
    // Shell grouping characters are word boundaries for matching purposes:
    // "(git commit)" must not smuggle git behind a "(git" token.
    if (GROUPING.has(ch)) {
      push();
      continue;
    }
    if (ch === " " || ch === "\t") {
      push();
      continue;
    }
    current += ch;
    hasCurrent = true;
  }
  push();
  return words;
}

// Normalize a segment to the argv git sees: drop wrappers (sudo, env, ...)
// and their flags, drop env assignments that may follow a wrapper (env and
// sudo both accept VAR=value before the command), then the first remaining
// word is the executable.
function commandWords(segment: string): string[] {
  const words = stripAndTokenize(segment);
  for (;;) {
    while (words.length > 0 && ENV_ASSIGNMENT.test(words[0])) {
      words.shift();
    }
    if (words.length === 0 || !WRAPPERS.has(words[0])) break;
    const wrapper = words.shift() as string;
    // Every wrapper's flags come before the command, even for wrappers with
    // no value-taking flags: `command -p git commit` must not die on "-p"
    // (round-2 agy finding).
    const valueFlags = WRAPPER_VALUE_FLAGS[wrapper];
    while (words.length > 0 && words[0].startsWith("-")) {
      const flag = words.shift() as string;
      if (valueFlags && !flag.includes("=") && valueFlags.has(flag) && words.length > 0) {
        words.shift();
      }
    }
  }
  return words;
}

export function isGitCommit(words: string[]): boolean {
  // Absolute or relative path to the binary is still git (/usr/bin/git).
  if ((words[0] ?? "").split("/").pop() !== "git") return false;
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    const option = words[i];
    i++;
    if (GIT_VALUE_OPTIONS.has(option) && !option.includes("=") && i < words.length) {
      i++;
    }
  }
  return words[i] === "commit";
}

export function isShellGitCommit(command: string): boolean {
  for (const segment of splitSegments(command)) {
    if (isGitCommit(commandWords(segment))) return true;
  }
  return false;
}

// tool_call handler factory. `enabled` is read per call so a /git
// deny-commit toggle applies without an extension reload; it is injectable
// only for tests. Returns undefined to let the call through, or the block
// shape pi expects ({ block, reason }) which is surfaced to the model as the
// tool error.
export function shellCommitBlocker(
  enabled: () => boolean = getDenyShellCommitEnabled,
): (event: unknown) => Promise<{ block: true; reason: string } | undefined> {
  return async (event: unknown) => {
    if (!enabled()) return undefined;
    const toolName = SHELL_TOOL_NAMES.find((name) =>
      isToolCallEventType(name, event as Parameters<typeof isToolCallEventType>[1]),
    );
    if (!toolName) return undefined;
    const input = (
      event as {
        input?: { command?: unknown; cmd?: unknown; chars?: unknown; chars_b64?: unknown };
      }
    ).input;
    if (!input) return undefined;
    const candidates: string[] = [];
    if (toolName === "write_stdin") {
      if (typeof input.chars === "string") candidates.push(input.chars);
      if (typeof input.chars_b64 === "string") {
        candidates.push(Buffer.from(input.chars_b64, "base64").toString("utf8"));
      }
    } else {
      if (typeof input.command === "string") candidates.push(input.command);
      if (typeof input.cmd === "string") candidates.push(input.cmd);
    }
    if (!candidates.some((command) => isShellGitCommit(command))) return undefined;
    return { block: true, reason: SHELL_COMMIT_BLOCK_REASON };
  };
}
