import { describe, expect, it } from "vitest";
import {
	bridgeCallToolDef,
	bridgeToolInfoDef,
	bridgedPiTools,
	codemodeCatalog,
	formatBridgeToolInfo,
	parseBridgeCallRequest,
	partitionBridgeTools,
	serializeToolSchema,
} from "../src/bridge-catalog.js";

const all = [
	{ name: "web_search", sourceInfo: { source: "pi-web-search" } },
	{ name: "mcp:files", sourceInfo: { source: "pi-mcp-adapter" } },
	{ name: "read", sourceInfo: { source: "builtin" } },
	{ name: "antigravity", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "AskAntigravity", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "agy_web_search", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "agy_read_url", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "bridge_tool_info", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "bridge_call_tool", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "bash", sourceInfo: { source: "builtin" } },
];

describe("live Pi bridge catalog", () => {
	it("uses the active set, not the registered set", () => {
		expect(bridgedPiTools(all, ["read", "web_search"], "all", new Set(), "stream-json").map((t) => t.name)).toEqual(["web_search"]);
		expect(bridgedPiTools(all, ["mcp:files"], "all", new Set(), "stream-json").map((t) => t.name)).toEqual(["mcp:files"]);
	});
	it("supports session-only hide, MCP-only mode, and bridge-off", () => {
		const active = all.map((tool) => tool.name);
		expect(bridgedPiTools(all, active, "all", new Set(["web_search"]), "stream-json").map((t) => t.name)).toEqual(["mcp:files"]);
		expect(bridgedPiTools(all, active, "mcp", new Set(), "stream-json").map((t) => t.name)).toEqual(["mcp:files"]);
		expect(bridgedPiTools(all, active, "none", new Set(), "stream-json").map((t) => t.name)).toEqual([]);
	});
	it("never exposes the bridge's own tools, including the web wrappers and proxy tools", () => {
		const active = all.map((tool) => tool.name);
		expect(bridgedPiTools(all, active, "all", new Set(), "stream-json").map((t) => t.name)).toEqual(["web_search", "mcp:files"]);
	});
	it("ACP 'all' declares pi builtins directly; stream-json keeps them off (native mapping covers them)", () => {
		const active = all.map((tool) => tool.name);
		expect(bridgedPiTools(all, active, "all", new Set(), "acp").map((t) => t.name)).toEqual(["web_search", "mcp:files", "read", "bash"]);
		expect(bridgedPiTools(all, active, "all", new Set(), "stream-json").map((t) => t.name)).toEqual(["web_search", "mcp:files"]);
	});
	it("ACP non-'all' modes keep the current catalog shape", () => {
		const active = all.map((tool) => tool.name);
		expect(bridgedPiTools(all, active, "none", new Set(), "acp").map((t) => t.name)).toEqual([]);
		expect(bridgedPiTools(all, active, "mcp", new Set(), "acp").map((t) => t.name)).toEqual(["mcp:files"]);
		expect(bridgedPiTools(all, active, "codemode", new Set(), "acp").map((t) => t.name)).toEqual(["web_search", "mcp:files"]);
	});
});

describe("hybrid partition and proxy helpers", () => {
	it("keeps only Pi default tool names in direct and moves all extension tools to proxied", () => {
		const tools = [
			{ name: "read", description: "Read file" },
			{ name: "edit", description: "Edit file" },
			{ name: "write", description: "Write file" },
			{ name: "bash", description: "Run bash" },
			{ name: "grep", description: "Grep" },
			{ name: "find", description: "Find" },
			{ name: "ls", description: "List" },
			{ name: "git_commit", description: "Commit", parameters: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] } },
			{ name: "AskClaude", description: "Ask Claude" },
		];
		const { direct, proxied } = partitionBridgeTools(tools);
		expect(direct.map((t) => t.name)).toEqual(["read", "edit", "write", "bash", "grep", "find", "ls"]);
		expect(proxied.map((t) => t.name)).toEqual(["git_commit", "AskClaude"]);
	});

	it("formats requested tool schemas and reports missing or inactive names", () => {
		const tools = [
			{ name: "git_commit", description: "Commit staged changes", parameters: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] } },
		];
		const res = formatBridgeToolInfo(tools, ["git_commit", "AskClaude"]);
		expect(res.isError).toBe(false);
		expect(res.content[0].text).toContain("git_commit");
		expect(res.content[0].text).toContain("Commit staged changes");
		expect(res.content[0].text).toContain('"subject"');
		expect(res.content[0].text).toContain("Unknown or inactive tools: AskClaude");
	});

	it("validates bridge_call_tool requests against active authorized tools and JSON object args", () => {
		const authorized = [{ name: "git_commit" }, { name: "AskClaude" }];

		expect(parseBridgeCallRequest({ name: "git_commit", arguments_json: '{"subject":"fix: bug"}' }, authorized)).toEqual({
			ok: true,
			name: "git_commit",
			args: { subject: "fix: bug" },
		});
		expect(parseBridgeCallRequest({ name: "AskClaude" }, authorized)).toEqual({
			ok: true,
			name: "AskClaude",
			args: {},
		});

		const badJson = parseBridgeCallRequest({ name: "git_commit", arguments_json: "{bad" }, authorized);
		expect(badJson.ok).toBe(false);

		const arrayArgs = parseBridgeCallRequest({ name: "git_commit", arguments_json: "[1,2]" }, authorized);
		expect(arrayArgs.ok).toBe(false);

		const inactive = parseBridgeCallRequest({ name: "exec_command", arguments_json: "{}" }, authorized);
		expect(inactive.ok).toBe(false);

		const internal = parseBridgeCallRequest({ name: "bridge_call_tool", arguments_json: "{}" }, authorized);
		expect(internal.ok).toBe(false);

		expect(parseBridgeCallRequest({ name: "  AskClaude  ", arguments_json: "" }, authorized)).toEqual({
			ok: true,
			name: "AskClaude",
			args: {},
		});
		expect(parseBridgeCallRequest({ name: "AskClaude", arguments_json: null }, authorized)).toEqual({
			ok: true,
			name: "AskClaude",
			args: {},
		});
		expect(parseBridgeCallRequest({ name: "git_commit", arguments_json: { subject: "obj" } }, authorized)).toEqual({
			ok: true,
			name: "git_commit",
			args: { subject: "obj" },
		});
		expect(parseBridgeCallRequest({ name: "git_commit", arguments_json: 42 }, authorized).ok).toBe(false);
		expect(parseBridgeCallRequest({ name: "git_commit", arguments_json: "null" }, authorized).ok).toBe(false);
		expect(parseBridgeCallRequest({ name: "git_commit", arguments_json: "1" }, authorized).ok).toBe(false);
	});

	it("handles formatBridgeToolInfo edge cases, wildcard listing, and per-call cap", () => {
		const tools = Array.from({ length: 25 }, (_, i) => ({
			name: `ext_tool_${i}`,
			description: `Tool ${i}`,
		}));

		expect(formatBridgeToolInfo(tools, []).isError).toBe(true);
		expect(formatBridgeToolInfo(tools, "ext_tool_0").isError).toBe(true);
		expect(formatBridgeToolInfo(tools, ["missing_a", "missing_b"]).isError).toBe(true);

		const wildcard = formatBridgeToolInfo(tools, ["*"]);
		expect(wildcard.isError).toBe(false);
		expect(wildcard.content[0].text).toContain("Available extension tools (25):");
		expect(wildcard.content[0].text).toContain("ext_tool_24");

		const capped = formatBridgeToolInfo(tools, tools.map((t) => t.name));
		expect(capped.isError).toBe(false);
		expect(capped.content[0].text).toContain("ext_tool_19");
		expect(capped.content[0].text).not.toContain("### ext_tool_20");
		expect(capped.content[0].text).toContain("truncated to first 20");
	});

	it("caps bridgeToolInfoDef description for huge catalogs, strips newlines, and falls back on circular schemas", () => {
		const circular: Record<string, unknown> = { type: "object" };
		circular.self = circular;
		expect(serializeToolSchema(circular)).toEqual({ type: "object", properties: {}, additionalProperties: true });

		const huge = Array.from({ length: 250 }, (_, i) => ({ name: `very_long_extension_tool_name_${i}\n` }));
		const infoDef = bridgeToolInfoDef(huge);
		expect(infoDef.description.length).toBeLessThan(4500);
		expect(infoDef.description).not.toContain("\n");
		expect(infoDef.description).toContain('pass names: ["*"] to list all');
		expect(bridgeCallToolDef().name).toBe("bridge_call_tool");
	});

	it("integrates bridgedPiTools with partitionBridgeTools for builtin vs extension-overridden defaults", () => {
		const catalog = [
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "read", sourceInfo: { source: "extension" } },
			{ name: "git_commit", sourceInfo: { source: "extension" } },
		];
		const authorized = bridgedPiTools(catalog, ["bash", "read", "git_commit"], "all", new Set(), "stream-json");
		const { direct, proxied } = partitionBridgeTools(authorized);
		expect(direct.map((t) => t.name)).toEqual(["read"]);
		expect(proxied.map((t) => t.name)).toEqual(["git_commit"]);
	});
});

describe("codemode catalog mode", () => {
	const allWithCm = [{ name: "codemode", sourceInfo: { source: "builtin" } }, ...all];
	const active = allWithCm.map((tool) => tool.name);

	it("bridges codemode plus extension tools, nothing builtin besides codemode", () => {
		expect(bridgedPiTools(allWithCm, active, "codemode", new Set(), "stream-json").map((t) => t.name)).toEqual([
			"codemode",
			"web_search",
			"mcp:files",
		]);
	});

	it("still respects the active set, hiding, and bridge-off", () => {
		expect(bridgedPiTools(allWithCm, ["codemode"], "codemode", new Set(), "stream-json").map((t) => t.name)).toEqual(["codemode"]);
		expect(bridgedPiTools(allWithCm, active, "codemode", new Set(["codemode"]), "stream-json").map((t) => t.name)).toEqual(["web_search", "mcp:files"]);
		expect(bridgedPiTools(allWithCm, active, "none", new Set(), "stream-json").map((t) => t.name)).toEqual([]);
	});

	it("keeps the all-mode builtin exclusion on stream-json", () => {
		expect(bridgedPiTools(allWithCm, active, "all", new Set(), "stream-json").map((t) => t.name)).toEqual(["web_search", "mcp:files"]);
	});
});

describe("codemodeCatalog projection", () => {
	it("projects codemode direct and everything else proxied", () => {
		const authorized = [
			{ name: "codemode", description: "Run scripts.", parameters: { type: "object", properties: { code: { type: "string" } } } },
			{ name: "subagent", description: "Delegate.", parameters: { type: "object" } },
			{ name: "read", description: "Read files.", parameters: { type: "object" } },
		];
		const { direct, proxied } = codemodeCatalog(authorized);
		expect(direct.map((t) => t.name)).toEqual(["codemode"]);
		expect(direct[0]?.description).toBe("Run scripts.");
		expect(direct[0]?.inputSchema).toEqual({ type: "object", properties: { code: { type: "string" } } });
		expect(proxied.map((t) => t.name)).toEqual(["subagent", "read"]);
	});

	it("falls back to an info/call-only catalog when codemode is not active", () => {
		const authorized = [{ name: "subagent", description: "Delegate." }];
		const { direct, proxied } = codemodeCatalog(authorized);
		expect(direct).toEqual([]);
		expect(proxied.map((t) => t.name)).toEqual(["subagent"]);
	});
});
