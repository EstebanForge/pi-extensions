import assert from "node:assert/strict";
import { test } from "vitest";
import { Box, type Component } from "@earendil-works/pi-tui";
import { renderEditDiffResult } from "../lib/diff-renderer";

const theme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

const diffConfig = {
	diffViewMode: "auto" as const,
	diffSplitMinWidth: 80,
	diffCollapsedLines: 24,
	diffWordWrap: false,
	diffIndicatorMode: "bars" as const,
	expandedPreviewMaxLines: 32,
};

function renderInsideToolBox(component: Component, width: number): string[] {
	const box = new Box(1, 1);
	box.addChild(component);
	return box.render(width);
}

function buildLargeUnifiedDiff(changeCount: number): string {
	const lines = [
		"--- a/large.txt",
		"+++ b/large.txt",
		`@@ -1,${changeCount} +1,${changeCount} @@`,
	];
	for (let lineNumber = 1; lineNumber <= changeCount; lineNumber++) {
		lines.push(`-old line ${lineNumber}`);
		lines.push(`+new line ${lineNumber}`);
	}
	return lines.join("\n");
}

test("issue #23: expanded large diffs stay bounded for small tmux panes", () => {
	const component = renderEditDiffResult(
		{ diff: buildLargeUnifiedDiff(80) },
		{ expanded: true, filePath: "large.txt" },
		diffConfig as any,
		theme,
		"",
	);

	const lines = renderInsideToolBox(component, 100);
	assert.ok(
		lines.length <= diffConfig.expandedPreviewMaxLines + 8,
		`expected expanded large diff to stay bounded near ${diffConfig.expandedPreviewMaxLines} lines, rendered ${lines.length}`,
	);
	assert.ok(
		lines.some((line) => /remaining|omitted|collapsed|more/i.test(line)),
		"expected a visible truncation hint for omitted large-diff content",
	);
});
// Upstream also pinned "PR #24: lockfile uses patched esbuild 0.28.1" here. That
// test read the package's own package-lock.json, which does not exist in this
// monorepo (root owns dependencies; esbuild was upstream's bundler, not a
// runtime dep). Dropped with the repackage.
