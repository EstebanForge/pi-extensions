/**
 * Descending numeric version compare, extracted verbatim from
 * pi-ask-codex and pi-ask-antigravity. "5.10" > "5.9" (lexical sort would
 * wrongly rank "5.9" higher because '9' > '1'). Callers pass numeric dotted
 * segments only ("6.1"), never full model slugs.
 */
export function compareVersionsDesc(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return db - da; // descending
	}
	return 0;
}
