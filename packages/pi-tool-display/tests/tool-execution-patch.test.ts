import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../lib/types";

// The patch module reads ToolExecutionComponent.prototype at patch time, so the
// mock supplies a minimal stand-in whose accessors behave like pi 1.0.0's
// (prototype methods, per-instance toolDefinition). The mocked binding is
// imported dynamically and typed structurally: the real class type does not
// describe the mock.

vi.mock("@earendil-works/pi-coding-agent", () => {
	class FakeToolExecutionComponent {
		toolDefinition?: unknown;
		constructor(toolDefinition?: unknown) {
			this.toolDefinition = toolDefinition;
		}
		getCallRenderer(): undefined {
			return undefined;
		}
		getResultRenderer(): undefined {
			return undefined;
		}
	}
	return { ToolExecutionComponent: FakeToolExecutionComponent };
});

const { default: registerToolExecutionMcpPatch } = await import("../lib/tool-execution-patch");

const { ToolExecutionComponent } = (await import("@earendil-works/pi-coding-agent")) as unknown as {
	ToolExecutionComponent: new (toolDefinition?: unknown) => {
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
// default config hides MCP output entirely.
registerToolExecutionMcpPatch(stubPi, () => ({
	...DEFAULT_TOOL_DISPLAY_CONFIG,
	mcpOutputMode: "summary",
}));

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

test("leaves built-in tool components on their original renderers", () => {
	const component = new ToolExecutionComponent({ name: "bash", description: "Run shell commands" });

	assert.equal(component.getCallRenderer(), undefined);
	assert.equal(component.getResultRenderer(), undefined);
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
