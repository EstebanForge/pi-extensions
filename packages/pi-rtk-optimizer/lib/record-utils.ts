export function toRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

export interface TextContentBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

/**
 * Narrows an unknown tool-result content block to a text block carrying a
 * string `text` payload. Shared by the compactor and the streaming sanitizer
 * so both walk content blocks with one consistent guard.
 */
export function isTextContentBlock(block: unknown): block is TextContentBlock & { text: string } {
	if (!block || typeof block !== "object" || Array.isArray(block)) {
		return false;
	}
	const contentBlock = block as TextContentBlock;
	return contentBlock.type === "text" && typeof contentBlock.text === "string";
}

/**
 * Walks tool-result content blocks, invoking `transform` for each text block.
 * Returns the mapped content and whether any text block changed. Non-text
 * blocks pass through untouched. Shared by the compactor and the streaming
 * sanitizer so both walk content with one consistent loop.
 */
export function mapTextContentBlocks(
	content: unknown[],
	transform: (block: TextContentBlock & { text: string }) => string | null,
): { changed: boolean; mapped: unknown[] } {
	let changed = false;
	const mapped = content.map((block) => {
		if (!isTextContentBlock(block)) {
			return block;
		}
		const nextText = transform(block);
		if (nextText === null || nextText === block.text) {
			return block;
		}
		changed = true;
		return { ...block, text: nextText };
	});
	return { changed, mapped };
}
