// agy per-engine state dirs ("brain" trees).
//
// Both engines keep per-conversation state on disk; the roots differ
// (live-probed 2026-09-24, this machine):
//   stream-json CLI:  ~/.gemini/antigravity-cli/brain/<conversationId>/
//   ACP server:       ~/.gemini/antigravity-acp/brain/<conversationId>/
// The ACP tree mirrors the CLI layout (.system_generated/tasks/,
// .system_generated/steps/), so downstream scans (tasks, artifacts) work
// unchanged once the right root is picked. A third tree exists —
// ~/.gemini/antigravity-cli/conversations/<uuid>.db — but it serves
// one-shot print-mode calls (AskAntigravity), NOT these features; do not
// conflate the two. Conversation ids are the raw ids agy reports, no
// hashing; the ids our session store persists match these dir names.

import os from "node:os";
import path from "node:path";
import type { Engine } from "./config.js";

/** Brain root for one engine. `home` injectable for tests. */
export function agyBrainRoot(engine: Engine, home: string = os.homedir()): string {
	const scope = engine === "acp" ? "antigravity-acp" : "antigravity-cli";
	return path.join(home, ".gemini", scope, "brain");
}

/** Per-conversation state dir. `conversationId` is the raw id agy reports
 *  (and what the session store persists). */
export function agyConversationDir(
	engine: Engine,
	conversationId: string,
	home: string = os.homedir(),
): string {
	return path.join(agyBrainRoot(engine, home), conversationId);
}
