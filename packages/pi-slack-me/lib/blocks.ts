// Shared blocks-param validation for the write tools. Slack wants `text`
// alongside blocks as the fallback copy, so both tools keep text required
// and treat blocks as the rich rendering layer.

export function parseBlocksParam(
  raw: string | undefined,
): { blocks?: unknown[]; error?: string } {
  if (raw === undefined) return {};
  try {
    const arr = JSON.parse(raw);
    if (
      !Array.isArray(arr) ||
      arr.length === 0 ||
      arr.length > 50 ||
      arr.some(
        (b) =>
          typeof b !== "object" || b === null || typeof (b as { type?: unknown }).type !== "string",
      )
    ) {
      return {
        error:
          "blocks must be a JSON array of 1-50 Block Kit block objects, each with a string type field.",
      };
    }
    return { blocks: arr };
  } catch {
    return { error: `blocks is not valid JSON: ${raw.slice(0, 120)}` };
  }
}
