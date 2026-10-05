import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolDisplayOverrides } from "../lib/tool-overrides";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../lib/types";

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RenderComponentLike {
	render(width: number): string[];
}

interface RenderCallContextLike {
	lastComponent?: unknown;
	state?: Record<string, unknown>;
	invalidate(): void;
	executionStarted: boolean;
	isPartial: boolean;
}

interface RegisteredToolLike {
	name: string;
	renderCall?: (args: unknown, theme: RenderThemeLike, context: RenderCallContextLike) => RenderComponentLike;
	renderResult?: (
		result: unknown,
		options: unknown,
		theme: unknown,
		context?: unknown,
	) => RenderComponentLike;
}

interface ToolEventHandlers {
	before_agent_start?: () => Promise<void> | void;
}

function buildConfig(overrides: Partial<ToolDisplayConfig>): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
	};
}

function createExtensionApiStub(): {
	api: ExtensionAPI;
	registeredTools: RegisteredToolLike[];
	eventHandlers: ToolEventHandlers;
} {
	const registeredTools: RegisteredToolLike[] = [];
	const eventHandlers: ToolEventHandlers = {};
	const api = {
		registerTool(tool: RegisteredToolLike): void {
			registeredTools.push(tool);
		},
		on(_event: string, handler: () => Promise<void> | void): void {
			eventHandlers[_event as keyof ToolEventHandlers] = handler;
		},
		getAllTools(): unknown[] {
			return ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({
				name,
				sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
			}));
		},
	} as unknown as ExtensionAPI;
	return { api, registeredTools, eventHandlers };
}

function createTheme(): RenderThemeLike {
	return {
		fg: (_color: string, value: string): string => value,
		bold: (value: string): string => value,
	};
}

function normalizeRenderedText(component: RenderComponentLike): string {
	return component
		.render(160)
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "");
}

interface ResultInput {
	text?: string;
	details?: unknown;
	expanded?: boolean;
	isPartial?: boolean;
	isError?: boolean;
}

function renderToolResult(
	tool: RegisteredToolLike | undefined,
	input: ResultInput,
	args?: Record<string, unknown>,
): string {
	assert.ok(tool?.renderResult, `expected renderResult for tool '${tool?.name ?? "unknown"}'`);
	const context = args === undefined ? undefined : { args };
	return normalizeRenderedText(
		tool.renderResult(
			{
				content: [{ type: "text", text: input.text ?? "" }],
				details: input.details ?? {},
				isError: input.isError ?? false,
			},
			{ isPartial: input.isPartial ?? false, expanded: input.expanded ?? false },
			createTheme(),
			context,
		),
	);
}

function renderToolCall(
	tool: RegisteredToolLike | undefined,
	args: Record<string, unknown>,
	contextOverrides: Partial<RenderCallContextLike> = {},
): string {
	assert.ok(tool?.renderCall, `expected renderCall for tool '${tool?.name ?? "unknown"}'`);
	const context: RenderCallContextLike = {
		lastComponent: contextOverrides.lastComponent,
		state: contextOverrides.state ?? {},
		invalidate: contextOverrides.invalidate ?? (() => {}),
		executionStarted: contextOverrides.executionStarted ?? false,
		isPartial: contextOverrides.isPartial ?? false,
	};
	return normalizeRenderedText(tool.renderCall(args, createTheme(), context));
}

async function registerWith(config: ToolDisplayConfig): Promise<RegisteredToolLike[]> {
	const stub = createExtensionApiStub();
	registerToolDisplayOverrides(stub.api, () => config);
	await stub.eventHandlers.before_agent_start?.();
	return stub.registeredTools;
}

function findTool(tools: RegisteredToolLike[], name: string): RegisteredToolLike {
	const tool = tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `expected registered tool '${name}'`);
	return tool;
}

test("tidy cards are the default: read renders an icon call line and a collapsed result summary", async () => {
	const tools = await registerWith(buildConfig({}));
	const read = findTool(tools, "read");

	assert.equal(renderToolCall(read, { path: "src/auth.ts" }), "📖 read src/auth.ts");
	assert.equal(renderToolResult(read, { text: "alpha\nbeta\n" }), "  → 2 lines");
});

test("tidy read output mode overrides stay collapsed and expansion shows the full output", async () => {
	const tools = await registerWith(buildConfig({ readOutputMode: "hidden" }));
	const read = findTool(tools, "read");

	assert.equal(renderToolResult(read, { text: "alpha\nbeta\n" }), "  → 2 lines");
	assert.equal(renderToolResult(read, { text: "alpha\nbeta\n", expanded: true }), "alpha\nbeta");
});

test("tidy read partial and error states stay on the card", async () => {
	const tools = await registerWith(buildConfig({}));
	const read = findTool(tools, "read");

	assert.equal(renderToolResult(read, { text: "", isPartial: true }), "  → running…");
	assert.equal(renderToolResult(read, { text: "boom\n", isError: true }), "  → failed: boom");
});

test("tidy grep and find summarize counts, files, and results", async () => {
	const tools = await registerWith(buildConfig({}));
	const grep = findTool(tools, "grep");
	const find = findTool(tools, "find");

	assert.equal(renderToolCall(grep, { pattern: "verifyToken", path: "src" }), "📖 grep /verifyToken/ in src");
	assert.equal(
		renderToolResult(grep, { text: "a.ts:1:alpha\nb.ts:2:beta\na.ts:3:gamma\n" }),
		"  → 3 matches in 2 files",
	);
	assert.equal(renderToolResult(find, { text: "a.txt\nb.txt\n" }), "  → 2 results");
});

test("tidy ls keeps entry counts", async () => {
	const tools = await registerWith(buildConfig({}));
	assert.equal(renderToolResult(findTool(tools, "ls"), { text: "a.txt\nb.txt\n" }), "  → 2 entries");
});

test("tidy bash keeps the shell call line and collapses output to a summary", async () => {
	const tools = await registerWith(buildConfig({}));
	const bash = findTool(tools, "bash");

	assert.equal(renderToolCall(bash, { command: "npm test" }), "$ npm test");
	assert.equal(renderToolResult(bash, { text: "alpha\nbeta\ngamma\n" }), "  → 3 lines");
	assert.equal(renderToolResult(bash, { text: "" }), "  → (no output)");
	assert.equal(renderToolResult(bash, { text: "alpha\nbeta\ngamma\n", expanded: true }), "alpha\nbeta\ngamma");
});

test("tidy bash failures summarize the first error line and expand to full output", async () => {
	const tools = await registerWith(buildConfig({}));
	const bash = findTool(tools, "bash");

	assert.equal(
		renderToolResult(bash, { text: "npm ERR! missing script: test\nsee npm help\n", isError: true }),
		"  → failed: npm ERR! missing script: test",
	);
	assert.equal(
		renderToolResult(bash, {
			text: "npm ERR! missing script: test\nsee npm help\n",
			isError: true,
			expanded: true,
		}),
		"npm ERR! missing script: test\nsee npm help",
	);
});

test("tidy edit shows a +/- delta when collapsed and the diff when expanded", async () => {
	const tools = await registerWith(buildConfig({}));
	const edit = findTool(tools, "edit");
	const args = { path: "src/auth.ts", oldText: "a", newText: "b" };

	assert.equal(
		renderToolResult(edit, { text: "ok\n", details: { diff: "+b\n-a\n context\n" } }, args),
		"  → +1/-1",
	);

	const expanded = renderToolResult(
		edit,
		{ text: "ok\n", details: { diff: "+b\n-a\n context\n" }, expanded: true },
		args,
	);
	assert.match(expanded, /b/);
	assert.notEqual(expanded, "  → +1/-1");
});

test("tidy edit errors and partial states keep the classic paths", async () => {
	const tools = await registerWith(buildConfig({}));
	const edit = findTool(tools, "edit");
	const args = { path: "src/auth.ts", oldText: "a", newText: "b" };

	assert.equal(
		renderToolResult(edit, { text: "boom\n", isError: true }, args),
		"boom",
	);
	assert.match(
		renderToolResult(edit, { text: "", isPartial: true }, args),
		/editing/,
	);
});

test("tidy write summarizes the written line count", async () => {
	const tools = await registerWith(buildConfig({}));
	const write = findTool(tools, "write");
	const args = { path: "src/auth.ts", content: "alpha\nbeta\n" };

	assert.match(renderToolCall(write, args), /^✏️ write src\/auth\.ts/);
	assert.equal(renderToolResult(write, { text: "ok\n" }, args), "  → 2 lines");
});

test("tidy expanded output respects expandedPreviewMaxLines", async () => {
	const tools = await registerWith(buildConfig({ expandedPreviewMaxLines: 3 }));
	const read = findTool(tools, "read");

	assert.equal(
		renderToolResult(read, { text: "one\ntwo\nthree\nfour\nfive\n", expanded: true }),
		"one\ntwo\nthree\n(display capped at 3 lines by tool-display setting)",
	);
});

test("tidy bash keeps truncation hints on collapsed and expanded results", async () => {
	const tools = await registerWith(buildConfig({ showTruncationHints: true }));
	const bash = findTool(tools, "bash");
	const details = { truncation: { truncated: true }, fullOutputPath: "/tmp/out.log" };

	assert.equal(
		renderToolResult(bash, { text: "alpha\n", details }),
		"  → 1 line\n(output truncated • full output: /tmp/out.log)",
	);
	assert.equal(
		renderToolResult(bash, { text: "alpha\nbeta\n", details, expanded: true }),
		"alpha\nbeta\n(output truncated • full output: /tmp/out.log)",
	);
});

test("tidy expanded errors with no output still name the failure", async () => {
	const tools = await registerWith(buildConfig({}));
	const bash = findTool(tools, "bash");

	assert.equal(renderToolResult(bash, { text: "", isError: true, expanded: true }), "  → failed");
});

test("tidy error summaries never leak raw ANSI resets from tool output", async () => {
	const tools = await registerWith(buildConfig({}));
	const bash = findTool(tools, "bash");

	const rendered = renderToolResult(bash, { text: "\u001b[0mboom\n", isError: true });
	assert.ok(rendered.startsWith("  → failed: "));
	assert.ok(!rendered.includes("\u001b[0m"), "raw reset must be sanitized before embedding");
});

test("tidyCards=false restores the classic rendering exactly", async () => {
	const tools = await registerWith(
		buildConfig({ tidyCards: false, readOutputMode: "summary" }),
	);
	const read = findTool(tools, "read");

	assert.equal(renderToolCall(read, { path: "src/auth.ts" }), "read src/auth.ts");
	assert.equal(renderToolResult(read, { text: "alpha\nbeta\n" }), "↳ loaded 2 lines • Ctrl+O to expand");
});
