import { describe, expect, it } from "vitest";
import { bridgedPiTools } from "../src/bridge-catalog.js";

const all = [
	{ name: "web_search", sourceInfo: { source: "pi-web-search" } },
	{ name: "mcp:files", sourceInfo: { source: "pi-mcp-adapter" } },
	{ name: "read", sourceInfo: { source: "builtin" } },
	{ name: "antigravity", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "AskAntigravity", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "agy_web_search", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "agy_read_url", sourceInfo: { source: "pi-antigravity-bridge" } },
];

describe("live Pi bridge catalog", () => {
	it("uses the active set, not the registered set", () => {
		expect(bridgedPiTools(all, ["read", "web_search"], "all", new Set()).map((t) => t.name)).toEqual(["web_search"]);
		expect(bridgedPiTools(all, ["mcp:files"], "all", new Set()).map((t) => t.name)).toEqual(["mcp:files"]);
	});
	it("supports session-only hide, MCP-only mode, and bridge-off", () => {
		const active = all.map((tool) => tool.name);
		expect(bridgedPiTools(all, active, "all", new Set(["web_search"])).map((t) => t.name)).toEqual(["mcp:files"]);
		expect(bridgedPiTools(all, active, "mcp", new Set()).map((t) => t.name)).toEqual(["mcp:files"]);
		expect(bridgedPiTools(all, active, "none", new Set()).map((t) => t.name)).toEqual([]);
	});
	it("never exposes the bridge's own tools, including the web wrappers", () => {
		const active = all.map((tool) => tool.name);
		expect(bridgedPiTools(all, active, "all", new Set()).map((t) => t.name)).toEqual(["web_search", "mcp:files"]);
	});
});
