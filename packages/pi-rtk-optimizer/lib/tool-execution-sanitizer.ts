import { mapTextContentBlocks, toRecord } from "./record-utils.js";
import { stripAnsiFast } from "./techniques/ansi.js";

export interface StreamingBashExecutionSanitizationResult {
	changed: boolean;
	result: unknown;
}

function sanitizeStreamingBashText(text: string, _command: string | undefined | null): string {
	return stripAnsiFast(text);
}

/**
 * Returns a sanitized shallow copy of streamed bash result blocks before the
 * TUI renders them so RTK self-diagnostics never flash in partial or final
 * tool output. The input object is not mutated.
 */
export function sanitizeStreamingBashExecutionResult(
	result: unknown,
	command: string | undefined | null,
): StreamingBashExecutionSanitizationResult {
	const resultRecord = toRecord(result);
	const sourceContent = Array.isArray(resultRecord.content)
		? (resultRecord.content as unknown[])
		: null;
	if (!sourceContent || sourceContent.length === 0) {
		return { changed: false, result };
	}

	const { changed, mapped: nextContent } = mapTextContentBlocks(sourceContent, (block) => {
		const sanitizedText = sanitizeStreamingBashText(block.text, command);
		return sanitizedText !== block.text ? sanitizedText : null;
	});

	if (!changed) {
		return { changed: false, result };
	}

	return {
		changed: true,
		result: {
			...resultRecord,
			content: nextContent,
		},
	};
}
