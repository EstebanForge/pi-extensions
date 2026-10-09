/**
 * Claude Code peer adapter: the claude-specific domain knowledge shared by
 * pi-ask-claude and (later) pi-unblock consults. Extracted verbatim from
 * pi-ask-claude's extensions/index.ts (behavior-preserving).
 *
 * Scope: argv construction for `claude -p`, the stream-json event grammar
 * (session capture, result/usage extraction, assistant-text fallback),
 * status-line vocabulary, and stderr noise filtering. Orchestration
 * (registry, wake, UI, config) stays in the extension.
 */

/** Claude session ids and --session-id values are UUIDs. Anchored to UUID
 *  shape so a leading-dash value (e.g. "--verbose") can NEVER pass and
 *  misbind on claude's arg parser as the token after --resume / --session-id. */
export const CLAUDE_SESSION_ID_RE =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Minimal shapes for the JSONL stream-json events we consume. Unknown
// fields are ignored. See: Claude Code CLI `--output-format stream-json`.
export interface ClaudeStreamEvent {
	type: string;
	subtype?: string;
	session_id?: string;
	result?: string;
	is_error?: boolean;
	num_turns?: number;
	total_cost_usd?: number;
	duration_ms?: number;
	usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
	message?: {
		role?: string;
		// Unified block shape: a discriminated union collapses here because
		// { type: "tool_use" } is assignable to a { type: string } fallback, so
		// one object with all-optional fields keeps `block.type === "tool_use"`
		// narrowing AND lets us read name/input/text/is_error without casts.
		content?: Array<{
			type: string;
			text?: string;
			thinking?: string;
			name?: string;
			input?: Record<string, unknown>;
			is_error?: boolean;
		}>;
	};
}

export const STATUS_LINES_MAX = 100;

/** Mutable accumulator the event consumer writes into. The extension maps
 *  these onto its own details after each event so partial progress stays
 *  observably identical. */
export interface ClaudeEventState {
	/** Session id from the init event; only set when still unset. */
	sessionId: string | null;
	/** Final result-event text; empty when claude emitted no result event. */
	finalMessage: string;
	/** Accumulated assistant text; the fallback answer when finalMessage is empty. */
	assistantText: string;
	resultIsError: boolean;
	resultSubtype: string | null;
	usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null;
	costUsd: number | null;
	turns: number | null;
	statusLines: string[];
}

export function emptyClaudeEventState(): ClaudeEventState {
	return {
		sessionId: null,
		finalMessage: "",
		assistantText: "",
		resultIsError: false,
		resultSubtype: null,
		usage: null,
		costUsd: null,
		turns: null,
		statusLines: [],
	};
}

// --- Argv building ----------------------------------------------------------

// Read-only tool allowlist for `read` mode. These tools never trigger a
// permission prompt, so the run stays fully non-interactive in --print
// mode. Mutating tools (Edit/Write/Bash/...) are simply absent, so Claude
// cannot change anything; MCP and subagent tools are excluded too.
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "TodoWrite"];

export interface BuildArgsOptions {
	model?: string;
	effort: string;
	mode: "read" | "none" | "full";
	allowFullMode: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	sessionId?: string; // defined + valid UUID => resume; undefined => fresh
	extraArgs: string[];
}

/** Build the `claude` argv. The PROMPT IS NOT INCLUDED here: it is delivered
 *  via stdin, because `--allowedTools` / `--tools` are variadic flags that
 *  would otherwise swallow a positional prompt. Pure function so tests can
 *  pin the shape. `plan` mode is deliberately avoided — it needs interactive
 *  plan approval and errors out headless (error_during_execution). */
export function buildClaudeArgs(opts: BuildArgsOptions): string[] {
	const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
	args.push(...opts.extraArgs);

	if (opts.model && opts.model.trim()) args.push("--model", opts.model.trim());
	if (opts.effort !== "default") args.push("--effort", opts.effort);

	// Permission / tool surface per mode.
	if (opts.mode === "full") {
		if (!opts.allowFullMode) {
			// Caller should have rejected this already; degrade to read.
			args.push("--allowedTools", READ_ONLY_TOOLS.join(","));
		} else {
			args.push("--permission-mode", "bypassPermissions");
		}
	} else if (opts.mode === "none") {
		// Disable every built-in tool: pure general knowledge.
		args.push("--tools", "");
	} else {
		// read: explicit read-only allowlist (no prompts, no mutations).
		args.push("--allowedTools", READ_ONLY_TOOLS.join(","));
	}

	if (opts.systemPrompt && opts.systemPrompt.trim()) {
		args.push("--system-prompt", opts.systemPrompt);
	}
	if (opts.appendSystemPrompt && opts.appendSystemPrompt.trim()) {
		args.push("--append-system-prompt", opts.appendSystemPrompt);
	}

	if (opts.sessionId && CLAUDE_SESSION_ID_RE.test(opts.sessionId)) {
		args.push("--resume", opts.sessionId);
	}
	// Fresh runs do NOT pass --session-id: claude assigns the id and reports
	// it in the `system/init` event, which we capture during streaming.

	return args;
}

// --- Stream event consumption ----------------------------------------------

function shorten(text: string, limit = 96): string {
	const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
	if (!normalized) return "";
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, limit - 3)}...`;
}

function toolUseStatus(name: string | undefined, input: Record<string, unknown> | undefined): string {
	const n = String(name ?? "tool");
	switch (n) {
		case "Read":
			return `reading: ${shorten(String(input?.file_path ?? ""), 120)}`;
		case "Grep":
		case "Glob":
		case "LS":
			return `searching: ${shorten(String(input?.pattern ?? input?.path ?? ""), 120)}`;
		case "Edit":
		case "Write":
		case "NotebookEdit":
			return `editing: ${shorten(String(input?.file_path ?? ""), 120)}`;
		case "Bash":
			return `running: ${shorten(String(input?.command ?? ""), 140)}`;
		case "WebSearch":
			return `web search: ${shorten(String(input?.query ?? ""), 120)}`;
		case "WebFetch":
			return `web fetch: ${shorten(String(input?.url ?? ""), 120)}`;
		case "Task":
		case "TaskCreate":
		case "TaskUpdate":
			return `subtask: ${n}`;
		case "TodoWrite":
			return "plan updated";
		default:
			return `tool: ${n}`;
	}
}

/** Map one parsed stream event to a short human status line, or null when
 *  the event carries nothing worth surfacing (keeps status lean). */
function describeStreamEvent(ev: ClaudeStreamEvent): string | null {
	// SessionStart / hook lifecycle events are config noise, not progress.
	if (ev.type === "system") {
		return null;
	}
	if (ev.type === "assistant" && ev.message?.content) {
		for (const block of ev.message.content) {
			if (block.type === "tool_use") {
				return toolUseStatus(block.name, block.input);
			}
		}
		// Text/thinking-only assistant turn: no per-line status (the final
		// answer comes from the `result` event).
		return null;
	}
	if (ev.type === "user" && ev.message?.content) {
		for (const block of ev.message.content) {
			if (block.type === "tool_result" && block.is_error) return "tool error";
		}
		return null;
	}
	return null;
}

/** Consume one stream-json event into the state accumulator. */
export function consumeClaudeEvent(ev: ClaudeStreamEvent, st: ClaudeEventState): void {
	// Confirm/repair session id from the init event.
	if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
		if (!st.sessionId) st.sessionId = ev.session_id;
	}
	if (ev.type === "result") {
		if (typeof ev.result === "string") st.finalMessage = ev.result;
		if (typeof ev.is_error === "boolean") st.resultIsError = ev.is_error;
		if (typeof ev.subtype === "string") st.resultSubtype = ev.subtype;
		if (ev.usage) {
			st.usage = {
				inputTokens: ev.usage.input_tokens ?? 0,
				outputTokens: ev.usage.output_tokens ?? 0,
				cacheReadTokens: ev.usage.cache_read_input_tokens ?? 0,
				cacheWriteTokens: ev.usage.cache_creation_input_tokens ?? 0,
			};
		}
		if (typeof ev.total_cost_usd === "number") st.costUsd = ev.total_cost_usd;
		if (typeof ev.num_turns === "number") st.turns = ev.num_turns;
		return;
	}
	// Accumulate assistant text as a fallback for the final answer when no
	// `result` event is emitted (timeout/abort).
	if (ev.type === "assistant" && ev.message?.content) {
		for (const block of ev.message.content) {
			if (block.type === "text" && block.text) {
				st.assistantText += block.text;
			}
		}
	}
	const line = describeStreamEvent(ev);
	if (line && st.statusLines.length < STATUS_LINES_MAX) st.statusLines.push(line);
}

// --- stderr ----------------------------------------------------------------

/** Drop claude stderr lines that aren't real errors: the stdin-wait notice
 *  and benign config warnings. */
export function cleanClaudeStderr(buf: string): string {
	return buf
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter(
			(l) =>
				l &&
				!l.startsWith("Warning: no stdin data received") &&
				!/^claude:?\s*$/i.test(l),
		)
		.join("\n");
}
