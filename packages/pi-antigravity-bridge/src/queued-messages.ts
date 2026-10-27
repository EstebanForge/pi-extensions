// Settings manager for Antigravity's "Queued Messages" delivery strategy.
//
// In agy v1.2.14+, agy introduced the "Queued Messages" option:
// - "queue" (agy default): hold follow-up / steering messages until current turn ends
// - "send-immediately": interrupt the agent with follow-up / steering messages immediately
//
// Pi expects immediate message delivery / steering during interactive chat.
// This module ensures that both the stream-json engine (~/.gemini/antigravity-cli/settings.json)
// and ACP engine (~/.gemini/antigravity-acp/settings.json) default to "send-immediately"
// so user steering works as expected in Pi without manual user configuration.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const QUEUED_MESSAGES_SEND_IMMEDIATELY = "send-immediately";

export function defaultCliSettingsPath(): string {
	return path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

export function defaultAcpSettingsPath(): string {
	return path.join(os.homedir(), ".gemini", "antigravity-acp", "settings.json");
}

export interface EnsureFileResult {
	path: string;
	updated: boolean;
	value: string;
	error?: string;
}

export interface EnsureFileOptions {
	defaultValue?: string;
	onlyIfDirExists?: boolean;
}

/**
 * Ensure `queuedMessages` is present in the specified settings.json file.
 * If unset or empty, writes `send-immediately`.
 *
 * Safety guards:
 * - If the file exists but has invalid JSON or is not an object, does NOT clobber; returns updated: false.
 * - If the file already specifies a non-empty `queuedMessages`, leaves it untouched.
 * - Resolves symlinks before writing to protect dotfiles managers.
 * - Writes via temp file and atomic rename.
 * - Traps any I/O exceptions so callers never crash on read-only or permission-denied files.
 */
export function ensureQueuedMessagesInFile(
	filePath: string,
	opts: EnsureFileOptions | string = {},
): EnsureFileResult {
	const options: EnsureFileOptions =
		typeof opts === "string" ? { defaultValue: opts } : opts;
	const defaultValue = options.defaultValue ?? QUEUED_MESSAGES_SEND_IMMEDIATELY;
	const onlyIfDirExists = options.onlyIfDirExists ?? false;

	let resolvedPath = filePath;
	try {
		if (fs.existsSync(filePath)) {
			resolvedPath = fs.realpathSync(filePath);
		}
	} catch {
		// Keep original path if realpath fails
	}

	const dir = path.dirname(resolvedPath);
	if (onlyIfDirExists && !fs.existsSync(dir)) {
		return { path: resolvedPath, updated: false, value: "" };
	}

	let settings: Record<string, unknown> = {};
	let fileExists = false;

	try {
		const raw = fs.readFileSync(resolvedPath, "utf8");
		fileExists = true;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (parseErr) {
			// Malformed JSON: do NOT clobber the user's file.
			return {
				path: resolvedPath,
				updated: false,
				value: "",
				error: `malformed JSON in ${resolvedPath}: ${String(parseErr)}`,
			};
		}

		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				path: resolvedPath,
				updated: false,
				value: "",
				error: `settings in ${resolvedPath} is not a JSON object`,
			};
		}
		settings = parsed as Record<string, unknown>;
	} catch (err: unknown) {
		const code = (err as { code?: string })?.code;
		if (code !== "ENOENT") {
			// Read error other than absent file (e.g. EACCES): do not overwrite.
			return {
				path: resolvedPath,
				updated: false,
				value: "",
				error: `failed reading ${resolvedPath}: ${String(err)}`,
			};
		}
	}

	const current = settings.queuedMessages;
	if (typeof current === "string" && current.trim().length > 0) {
		return { path: resolvedPath, updated: false, value: current };
	}

	settings.queuedMessages = defaultValue;

	let tmpPath = "";
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		tmpPath = path.join(dir, `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.tmp`);
		fs.writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(tmpPath, resolvedPath);
		return { path: resolvedPath, updated: true, value: defaultValue };
	} catch (err) {
		if (tmpPath) {
			try {
				fs.unlinkSync(tmpPath);
			} catch {
				/* ignore */
			}
		}
		return {
			path: resolvedPath,
			updated: false,
			value: "",
			error: `failed writing ${resolvedPath}: ${String(err)}`,
		};
	}
}

export interface EnsureQueuedMessagesOptions {
	cliSettingsPath?: string;
	acpSettingsPath?: string;
	defaultValue?: string;
	onlyIfDirExists?: boolean;
}

export interface EnsureQueuedMessagesReport {
	cli: EnsureFileResult;
	acp: EnsureFileResult;
}

/**
 * Ensure both stream-json (CLI) and ACP engines default to "send-immediately".
 */
export function ensureQueuedMessagesDefaults(
	opts: EnsureQueuedMessagesOptions = {},
): EnsureQueuedMessagesReport {
	const cliPath = opts.cliSettingsPath ?? defaultCliSettingsPath();
	const acpPath = opts.acpSettingsPath ?? defaultAcpSettingsPath();
	const defVal = opts.defaultValue ?? QUEUED_MESSAGES_SEND_IMMEDIATELY;
	const onlyIfDirExists = opts.onlyIfDirExists ?? false;

	const cli = ensureQueuedMessagesInFile(cliPath, { defaultValue: defVal, onlyIfDirExists });
	const acp = ensureQueuedMessagesInFile(acpPath, { defaultValue: defVal, onlyIfDirExists });

	return { cli, acp };
}
