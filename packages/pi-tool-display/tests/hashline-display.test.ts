import assert from "node:assert/strict";
import { test } from "vitest";
import { getHashlineDisplayRenderers, HASHLINE_TOOL_NAMES } from "../lib/hashline-display";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../lib/types";

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RenderComponentLike {
	render(width: number): string[];
}

type Renderers = ReturnType<typeof getHashlineDisplayRenderers>;

function buildConfig(overrides: Partial<ToolDisplayConfig> = {}): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
	};
}

function createTheme(): RenderThemeLike {
	return {
		fg: (_color: string, value: string): string => value,
		bold: (value: string): string => value,
	};
}

function renderToText(component: unknown): string {
	const render = component && typeof component === "object"
		? (component as { render?: unknown }).render
		: undefined;
	assert.equal(typeof render, "function", "expected a renderable component");
	return (component as RenderComponentLike)
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function callLine(renderers: NonNullable<Renderers>, args: Record<string, unknown>): string {
	assert.equal(typeof renderers.renderCall, "function");
	return renderToText(renderers.renderCall(args, createTheme(), undefined));
}

function resultLine(
	renderers: NonNullable<Renderers>,
	result: Record<string, unknown>,
	options: Record<string, unknown> = {},
	context: Record<string, unknown> | undefined = undefined,
): string {
	assert.equal(typeof renderers.renderResult, "function");
	return renderToText(
		renderers.renderResult(
			result,
			{ expanded: false, isPartial: false, ...options },
			createTheme(),
			context,
		),
	);
}

function textResult(text: string): Record<string, unknown> {
	return { content: [{ type: "text", text }], details: {} };
}

const EDIT_DIFF_DETAILS = { diff: "+alpha\n-beta\n+gamma\n delta" };

test("hashline adapter table covers the extension's tool surface", () => {
	assert.deepEqual(
		[...HASHLINE_TOOL_NAMES].sort(),
		["anchor_grep", "copy", "insert", "move", "read", "replace", "replace_match", "undo_last_change"],
	);
});

test("adapter is gated by config and unknown tool names", () => {
	assert.equal(getHashlineDisplayRenderers("replace", () => buildConfig({ hashlineCards: false })), undefined);
	assert.equal(getHashlineDisplayRenderers("bash", () => buildConfig()), undefined);
	assert.equal(getHashlineDisplayRenderers("", () => buildConfig()), undefined);
	assert.ok(getHashlineDisplayRenderers("replace", () => buildConfig()));
});

test("replace call line prefers path, appends edit count, and falls back to anchors", () => {
	const renderers = getHashlineDisplayRenderers("replace", () => buildConfig());
	assert.ok(renderers);

	assert.equal(
		callLine(renderers, { path: "src/main.ts", remove_from: "a1b2c3", remove_to: "d4e5f6", text: "x" }),
		"◆ replace src/main.ts",
	);
	assert.equal(
		callLine(renderers, {
			path: "src/main.ts",
			changes: [
				{ hash_range_inclusive: ["ve7", "ve7"], content_lines: ["a"] },
				{ hash_range_inclusive: ["x1", "x2"], content_lines: ["b"] },
			],
		}),
		"◆ replace src/main.ts (2 edits)",
	);
	assert.equal(
		callLine(renderers, { remove_from: "a1b2c3d4e5", remove_to: "f6g7h8" }),
		"◆ replace a1b2c3…",
	);
	assert.equal(callLine(renderers, {}), "◆ replace ...");
});

test("replace result renders diff counts, noop, errors, partial, batch, and warnings", () => {
	const renderers = getHashlineDisplayRenderers("replace", () => buildConfig());
	assert.ok(renderers);

	assert.equal(resultLine(renderers, { ...textResult("ok"), details: EDIT_DIFF_DETAILS } as never), "→ +2/-1");
	assert.equal(
		resultLine(renderers, { ...textResult("ok"), details: { classification: "noop", diff: "" } } as never),
		"→ no changes",
	);
	assert.equal(
		resultLine(renderers, { isError: true, content: [{ type: "text", text: "[E_STALE] anchor moved" }] }),
		"→ failed: [E_STALE] anchor moved",
	);
	assert.equal(resultLine(renderers, textResult("half"), { isPartial: true } as never), "editing...");
	assert.equal(
		resultLine(
			renderers,
			{ ...textResult("ok"), details: { ...EDIT_DIFF_DETAILS, batch: { id: 4, size: 3, last: false } } } as never,
		),
		"→ +2/-1 • batch 4 queued (3 edits)",
	);
	assert.equal(
		resultLine(
			renderers,
			{ ...textResult("ok"), details: { ...EDIT_DIFF_DETAILS, warnings: ["w1", "w2"], hints: ["h1"] } } as never,
		),
		"→ +2/-1 • 2 warnings • 1 hint",
	);
	assert.equal(
		resultLine(renderers, { ...textResult("ok"), details: { diff: "" } } as never),
		"→ applied",
	);
});

test("context error flag renders the failure line", () => {
	const renderers = getHashlineDisplayRenderers("insert", () => buildConfig());
	assert.ok(renderers);
	assert.equal(
		resultLine(renderers, textResult("boom"), {}, { isError: true }),
		"→ failed: boom",
	);
});

test("expanded replace result renders the diff body", () => {
	const renderers = getHashlineDisplayRenderers("replace", () => buildConfig());
	assert.ok(renderers);
	const expanded = renderToText(
		renderers.renderResult(
			{ ...textResult("ok"), details: EDIT_DIFF_DETAILS },
			{ expanded: true, isPartial: false },
			createTheme(),
			undefined,
		),
	);
	assert.match(expanded, /alpha/);
	assert.match(expanded, /gamma/);
});

test("insert, replace_match, copy, move, and undo call lines", () => {
	const config = () => buildConfig();

	const insert = getHashlineDisplayRenderers("insert", config);
	assert.ok(insert);
	assert.equal(callLine(insert, { path: "a.ts", anchor: "ve7", text: "x" }), "◆ insert a.ts");

	const replaceMatch = getHashlineDisplayRenderers("replace_match", config);
	assert.ok(replaceMatch);
	assert.equal(
		callLine(replaceMatch, { pattern: "foo", path: "src", replace_with: "bar" }),
		"◆ replace_match /foo/ in src",
	);

	const copy = getHashlineDisplayRenderers("copy", config);
	assert.ok(copy);
	assert.equal(callLine(copy, { source_from: "a1b2", path: "dest.ts" }), "◆ copy → dest.ts");

	const move = getHashlineDisplayRenderers("move", config);
	assert.ok(move);
	assert.equal(callLine(move, { source_from: "a1b2", path: "dest.ts" }), "◆ move → dest.ts");

	const undo = getHashlineDisplayRenderers("undo_last_change", config);
	assert.ok(undo);
	assert.equal(callLine(undo, { path: "a.ts" }), "◆ undo_last_change a.ts");
});

test("anchor_grep call and result summarize like the grep card", () => {
	const renderers = getHashlineDisplayRenderers("anchor_grep", () => buildConfig());
	assert.ok(renderers);

	assert.equal(
		callLine(renderers, { pattern: "foo", path: "src", glob: "*.ts", limit: 5 }),
		"◆ anchor_grep /foo/ in src (*.ts) limit 5",
	);
	assert.equal(
		resultLine(renderers, textResult("src/a.ts:1: foo\nsrc/b.ts:2: foo\nsrc/b.ts:3: foo\n")),
		"→ 3 matches in 2 files",
	);
	assert.equal(resultLine(renderers, textResult("")), "→ (no output)");
});

test("read delegates to the built-in read card", () => {
	const renderers = getHashlineDisplayRenderers("read", () => buildConfig());
	assert.ok(renderers);
	assert.equal(callLine(renderers, { path: "docs/x.md", offset: 2, limit: 3 }), "📖 read docs/x.md:2-4");
});
