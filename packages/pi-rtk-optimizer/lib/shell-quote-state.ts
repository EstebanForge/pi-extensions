/**
 * Shared shell quote/escape state machine used by command-parsing helpers.
 *
 * Both the top-level pipeline splitter and the leading-`cd /d` parser walk a
 * command string character-by-character while tracking whether the cursor is
 * inside a quoted region and whether the current character is backslash-
 * escaped. This helper advances that state for one character so the two parsers
 * do not duplicate the transition logic.
 *
 * `quoteChars` selects which characters open a quote (e.g. `'"\'\`'` for the
 * pipeline parser, `'"\'` for the `cd /d` parser), preserving each caller's
 * exact quote semantics.
 *
 * Returns `true` when the character is consumed by the state machine (caller
 * should `continue` to the next character); returns `false` when the character
 * is a top-level, unquoted, unescaped token the caller must interpret.
 */
export interface QuoteEscapeState {
	quote: string | null;
	escaped: boolean;
}

export function advanceQuoteEscapeState(
	state: QuoteEscapeState,
	character: string,
	quoteChars: string,
): boolean {
	if (state.escaped) {
		state.escaped = false;
		return true;
	}

	if (state.quote !== null) {
		if (character === "\\" && state.quote !== "'") {
			state.escaped = true;
			return true;
		}
		if (character === state.quote) {
			state.quote = null;
		}
		return true;
	}

	if (character === "\\") {
		state.escaped = true;
		return true;
	}

	if (quoteChars.includes(character)) {
		state.quote = character;
		return true;
	}

	return false;
}

/**
 * Reads the current and next character from a command string at `index`,
 * returning empty strings past either end so callers can compare without
 * bounds checks. Shared by the command-parsing helpers that walk a command
 * character-by-character.
 */
export function readShellChars(
	command: string,
	index: number,
): { character: string; nextCharacter: string } {
	return {
		character: command[index] ?? "",
		nextCharacter: command[index + 1] ?? "",
	};
}
