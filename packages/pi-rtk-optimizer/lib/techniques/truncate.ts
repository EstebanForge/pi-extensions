// Omitted middle must stay explicit so the model can tell the two halves were
// never contiguous. Below this budget the marker would leave no usable content.
const TRUNCATION_MARKER = "\n... [RTK truncated middle] ...\n";

export function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}

	if (maxLength < 3) {
		return "...";
	}

	if (maxLength <= TRUNCATION_MARKER.length) {
		return `${text.slice(0, maxLength - 3)}...`;
	}

	const contentLength = maxLength - TRUNCATION_MARKER.length;
	const headLength = Math.ceil(contentLength / 2);
	const tailLength = contentLength - headLength;
	return `${text.slice(0, headLength)}${TRUNCATION_MARKER}${text.slice(text.length - tailLength)}`;
}
