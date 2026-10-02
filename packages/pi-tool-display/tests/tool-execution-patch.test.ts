import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltInDisplayRenderers } from "../lib/tool-overrides";
import { BUILT_IN_TOOL_OVERRIDE_NAMES, DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../lib/types";

// The patch module reads ToolExecutionComponent.prototype at patch time, so the
// mock supplies a minimal stand-in whose accessors behave like pi 1.0.0's
// (prototype methods reading the live toolDefinition, per-instance). The
// mocked binding is imported dynamically and typed structurally: the real
// class type does not describe the mock.

vi.mock("@earendil-works/pi-coding-agent", () => {
	class FakeToolExecutionComponent {
		toolDefinition?: unknown;
		toolName?: string;
		constructor(toolDefinition?: unknown, toolName?: string) {
			this.toolDefinition = toolDefinition;
			this.toolName = toolName;
		}
		getCallRenderer(): unknown {
			return (this.toolDefinition as { renderCall?: unknown } | undefined)?.renderCall;
		}
		getResultRenderer(): unknown {
			return (this.toolDefinition as { renderResult?: unknown } | undefined)?.renderResult;
		}
	}
	return { ToolExecutionComponent: FakeToolExecutionComponent };
});

const { default: registerToolExecutionMcpPatch } = await import("../lib/tool-execution-patch");

const { ToolExecutionComponent } = (await import("@earendil-works/pi-coding-agent")) as unknown as {
	ToolExecutionComponent: new (toolDefinition?: unknown, toolName?: string) => {
		getCallRenderer(): unknown;
		getResultRenderer(): unknown;
	};
};

const passThroughTheme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

const stubPi = { on: () => {} } as unknown as ExtensionAPI;

// Summary mode so the patched result renderer's output can be asserted; the
// default config hides MCP output entirely. Mutable binding so per-test config
// swaps reach the patch's lazy getConfig() closure.
let activeConfig: ToolDisplayConfig = { ...DEFAULT_TOOL_DISPLAY_CONFIG, mcpOutputMode: "summary" };
registerToolExecutionMcpPatch(stubPi, () => activeConfig);

function renderedText(component: unknown): string {
	return (component as { render(width: number): string[] })
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

test("patches MCP tool components with tool-display renderers", () => {
	const component = new ToolExecutionComponent({ name: "mcp", description: "Model Context Protocol tools" });

	const callRenderer = component.getCallRenderer() as
		| ((args: Record<string, unknown>, theme: unknown) => unknown)
		| undefined;
	assert.equal(typeof callRenderer, "function");
	const callLine = callRenderer?.({ query: "issues" }, passThroughTheme);
	assert.ok(callLine != null);
	const rendered = renderedText(callLine);
	assert.ok(rendered.includes("MCP"), `expected MCP marker in: ${rendered}`);
	assert.ok(rendered.includes("(1 arg)"), `expected arg suffix in: ${rendered}`);

	const resultRenderer = component.getResultRenderer();
	assert.equal(typeof resultRenderer, "function");
});

test("decorates stripped built-in definitions at render time", () => {
	// Subagent children re-wrap tool definitions and drop the extension's
	// renderers (upstream issue 47). The patch rebuilds them from the name.
	const component = new ToolExecutionComponent({ name: "grep", description: "Search file contents" });

	const callRenderer = component.getCallRenderer() as
		| ((args: Record<string, unknown>, theme: unknown) => unknown)
		| undefined;
	assert.equal(typeof callRenderer, "function");
	const callLine = callRenderer?.({ pattern: "foo", path: "." }, passThroughTheme);
	assert.ok(callLine != null);
	assert.ok(renderedText(callLine).includes("/foo/"), "expected the grep pattern in the rebuilt call line");

	const resultRenderer = component.getResultRenderer();
	assert.equal(typeof resultRenderer, "function");
});

test("keeps a definition that still carries its own renderers", () => {
	const ownRenderCall = (args: Record<string, unknown>, theme: unknown): unknown => args;
	const ownRenderResult = (result: unknown, options: unknown, theme: unknown): unknown => result;
	const component = new ToolExecutionComponent({
		name: "grep",
		description: "Search file contents",
		renderCall: ownRenderCall,
		renderResult: ownRenderResult,
	});

	assert.equal(component.getCallRenderer(), ownRenderCall);
	assert.equal(component.getResultRenderer(), ownRenderResult);
});

test("leaves tools without overrides on their original renderers", () => {
	const component = new ToolExecutionComponent({ name: "mystery_tool", description: "Not ours" });

	assert.equal(component.getCallRenderer(), undefined);
	assert.equal(component.getResultRenderer(), undefined);
});

test("getBuiltInDisplayRenderers respects the name list and per-tool overrides", () => {
	assert.equal(typeof getBuiltInDisplayRenderers("grep", () => DEFAULT_TOOL_DISPLAY_CONFIG)?.renderCall, "function");
	assert.equal(
		getBuiltInDisplayRenderers("mystery_tool", () => DEFAULT_TOOL_DISPLAY_CONFIG),
		undefined,
	);
	assert.equal(
		getBuiltInDisplayRenderers("grep", () => ({
			...DEFAULT_TOOL_DISPLAY_CONFIG,
			registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides, grep: false },
		})),
		undefined,
	);
});

test("decorates every owned built-in through the component patch", () => {
	for (const name of BUILT_IN_TOOL_OVERRIDE_NAMES) {
		const component = new ToolExecutionComponent({ name, description: "stripped by wrapping" });
		assert.equal(typeof component.getCallRenderer(), "function", name);
		assert.equal(typeof component.getResultRenderer(), "function", name);
	}
});

test("resolves stripped built-ins from the component tool name", () => {
	// Subagent wrappers can drop the definition's name too; the component's
	// own toolName then decides.
	const component = new ToolExecutionComponent(
		{ description: "stripped: no name, no renderers" },
		"grep",
	);

	const callRenderer = component.getCallRenderer() as
		| ((args: Record<string, unknown>, theme: unknown) => unknown)
		| undefined;
	assert.equal(typeof callRenderer, "function");
	const callLine = callRenderer?.({ pattern: "foo", path: "." }, passThroughTheme);
	assert.ok(callLine != null);
	assert.ok(renderedText(callLine).includes("/foo/"), "expected the grep pattern in the rebuilt call line");
});

test("keeps partially decorated definitions intact", () => {
	// A definition providing either renderer keeps its mixed rendering; we
	// never splice one of ours next to a foreign one.
	const ownRenderCall = (): unknown => null;
	const component = new ToolExecutionComponent({ name: "grep", renderCall: ownRenderCall });

	assert.equal(component.getCallRenderer(), ownRenderCall);
	assert.equal(component.getResultRenderer(), undefined);
});

test("leaves externally owned tools sharing a built-in name alone", () => {
	const component = new ToolExecutionComponent({
		name: "grep",
		description: "someone else's grep",
		sourceInfo: { source: "extension", path: "/somewhere/else.ts" },
	});

	assert.equal(component.getCallRenderer(), undefined);
	assert.equal(component.getResultRenderer(), undefined);
});

test("disabled per-tool override falls through to the original renderer", () => {
	const baseline = activeConfig;
	activeConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		mcpOutputMode: "summary",
		registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides, grep: false },
	};
	try {
		const component = new ToolExecutionComponent({ name: "grep", description: "Search file contents" });
		assert.equal(component.getCallRenderer(), undefined);
		assert.equal(component.getResultRenderer(), undefined);
	} finally {
		activeConfig = baseline;
	}
});

test("patched result renderer renders a text result in summary mode", () => {
	const component = new ToolExecutionComponent({ name: "mcp", description: "Model Context Protocol tools" });

	const resultRenderer = component.getResultRenderer() as
		| ((result: unknown, options: unknown, theme: unknown) => unknown)
		| undefined;
	assert.equal(typeof resultRenderer, "function");

	// Summary mode's expanded preview carries the output lines; the default
	// config would hide MCP output entirely.
	const rendered = resultRenderer?.(
		{ content: [{ type: "text", text: "mcp output line" }] },
		{ expanded: true, isPartial: false },
		passThroughTheme,
	);
	assert.ok(rendered != null);
	assert.ok(renderedText(rendered).includes("mcp output line"));
});

test("reload shutdown restores the original prototype accessors", async () => {
	const handlers = new Map<string, (event: unknown) => Promise<void>>();
	const pi = {
		on: (eventName: string, handler: (event: unknown) => Promise<void>) => {
			handlers.set(eventName, handler);
		},
	} as unknown as ExtensionAPI;

	registerToolExecutionMcpPatch(pi, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const component = new ToolExecutionComponent({ name: "mcp", description: "Model Context Protocol tools" });
	assert.equal(typeof component.getCallRenderer(), "function");

	await handlers.get("session_shutdown")?.({ reason: "reload" });

	assert.equal(component.getCallRenderer(), undefined);
	assert.equal(component.getResultRenderer(), undefined);
});
