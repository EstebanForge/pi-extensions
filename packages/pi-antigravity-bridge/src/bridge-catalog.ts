import type { BridgeTools } from "./config.js";
import { POLL_TOOL_NAME } from "./provider.js";
import { ACTIVATE_SKILL_TOOL_NAME } from "./skills.js";

export interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters?: object;
	sourceInfo?: { source?: string };
}

export const TOOL_INFO_TOOL_NAME = "bridge_tool_info";
export const CALL_TOOL_NAME = "bridge_call_tool";
const MAX_DESC_NAMES_CHARS = 4000;
const MAX_INFO_TOOLS_PER_CALL = 20;

/** Pi's seven built-in default tools; only these stay always-loaded when active. */
const PI_DEFAULT_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

const BRIDGE_INTERNAL_TOOLS = new Set([
	"AskAntigravity",
	"antigravity",
	"agy_web_search",
	"agy_read_url",
	POLL_TOOL_NAME,
	ACTIVATE_SKILL_TOOL_NAME,
	TOOL_INFO_TOOL_NAME,
	CALL_TOOL_NAME,
]);

const DEFAULT_INPUT_SCHEMA: object = { type: "object", properties: {}, additionalProperties: true };

/** Serialize a tool's TypeBox/JSON schema safely for MCP exposure. */
export function serializeToolSchema(parameters?: object): object {
	if (!parameters) return DEFAULT_INPUT_SCHEMA;
	try {
		return JSON.parse(JSON.stringify(parameters)) as object;
	} catch {
		return DEFAULT_INPUT_SCHEMA;
	}
}

/** The bridge has one live HTTP endpoint. Catalog and dispatch must both use
 * the CURRENT Pi active set: /mcp and pi.setActiveTools() can change it mid-session.
 * A stale tools/call must not bypass a disabled Pi tool. */
export function bridgedPiTools(
	all: BridgeToolInfo[], active: readonly string[], mode: BridgeTools, hidden: ReadonlySet<string>,
): BridgeToolInfo[] {
	if (mode === "none") return [];
	const enabled = new Set(active);
	return all.filter((tool) =>
		enabled.has(tool.name) && !hidden.has(tool.name) &&
		// Never bridge the bridge's own tools. agy has native web tools, so
		// our quota-burning one-shot wrappers must not tempt it through MCP.
		!BRIDGE_INTERNAL_TOOLS.has(tool.name) &&
		(mode === "codemode"
			// Codemode mode: pi's builtin codemode tool is the one builtin that
			// bridges (scripts reach the rest pi-side); the info/call pair covers
			// tools the engine should not call directly.
			? tool.name === "codemode" || tool.sourceInfo?.source !== "builtin"
			: mode === "mcp"
				? /pi-mcp-adapter/.test(tool.sourceInfo?.source ?? "")
				: tool.sourceInfo?.source !== "builtin"),
	);
}

/** Split authorized bridge tools into always-loaded Pi defaults and proxied extension tools. */
export function partitionBridgeTools<T extends BridgeToolInfo>(tools: readonly T[]): { direct: T[]; proxied: T[] } {
	const direct: T[] = [];
	const proxied: T[] = [];
	for (const tool of tools) {
		if (PI_DEFAULT_TOOLS.has(tool.name)) direct.push(tool);
		else proxied.push(tool);
	}
	return { direct, proxied };
}

/** Codemode-only catalog projection: pi's codemode tool is the one direct
 *  tool (its own description teaches the script grammar and pi executes the
 *  scripts with pi's tools injected), every other authorized tool rides the
 *  info/call pair so the engine never sees a wide direct catalog. */
export function codemodeCatalog<T extends BridgeToolInfo>(
	authorized: readonly T[],
): { direct: Array<{ name: string; description: string; inputSchema: object }>; proxied: T[] } {
	const cm = authorized.find((t) => t.name === "codemode");
	const proxied = authorized.filter((t) => t.name !== "codemode");
	const direct = cm
		? [{ name: cm.name, description: cm.description ?? cm.name, inputSchema: serializeToolSchema(cm.parameters) }]
		: [];
	return { direct, proxied };
}

/** Build the bridge_tool_info MCP tool definition listing proxied extension tool names. */
export function bridgeToolInfoDef(proxied: readonly BridgeToolInfo[]): {
	name: string;
	description: string;
	inputSchema: object;
} {
	const cleaned = proxied.map((t) => t.name.replace(/[\r\n]+/g, " ").trim()).filter(Boolean);
	let namesText = "";
	let shown = 0;
	for (const n of cleaned) {
		const next = shown === 0 ? n : `${namesText}, ${n}`;
		if (next.length > MAX_DESC_NAMES_CHARS && shown > 0) break;
		namesText = next;
		shown++;
	}
	const remainder = cleaned.length - shown;
	const suffix = remainder > 0 ? `, ... (+${remainder} more; pass names: ["*"] to list all)` : "";
	return {
		name: TOOL_INFO_TOOL_NAME,
		description: `Inspect description and parameter schema for extension Pi tools before calling them via ${CALL_TOOL_NAME}. Pass ["*"] to list all names. Available extension tools (${cleaned.length}): ${namesText}${suffix}`,
		inputSchema: {
			type: "object",
			properties: {
				names: {
					type: "array",
					items: { type: "string" },
					description: 'Exact Pi tool names to inspect (or ["*"] to list all available extension tools).',
				},
			},
			required: ["names"],
		},
	};
}

/** Build the bridge_call_tool MCP tool definition for invoking proxied extension tools. */
export function bridgeCallToolDef(): { name: string; description: string; inputSchema: object } {
	return {
		name: CALL_TOOL_NAME,
		description: `Invoke an extension Pi tool listed in ${TOOL_INFO_TOOL_NAME}. Inspect its schema with ${TOOL_INFO_TOOL_NAME} first, then pass its exact name and a stringified JSON object in arguments_json.`,
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Exact Pi tool name to invoke." },
				arguments_json: {
					type: "string",
					description: "Stringified JSON object of tool arguments (omit or '{}' if none).",
				},
			},
			required: ["name"],
		},
	};
}

/** Format full descriptions and schemas for requested Pi tools. */
export function formatBridgeToolInfo(
	authorized: readonly BridgeToolInfo[],
	rawNames: unknown,
): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
	const names = Array.isArray(rawNames)
		? rawNames.filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.trim())
		: [];
	if (names.length === 0) {
		return { content: [{ type: "text", text: "Error: names must be a non-empty array of tool names" }], isError: true };
	}
	if (names.includes("*")) {
		const list = authorized.map((t) => t.name).join(", ") || "(none)";
		return {
			content: [{ type: "text", text: `Available extension tools (${authorized.length}): ${list}` }],
			isError: false,
		};
	}
	const capped = names.slice(0, MAX_INFO_TOOLS_PER_CALL);
	const byName = new Map(authorized.map((t) => [t.name, t]));
	const sections: string[] = [];
	const missing: string[] = [];
	for (const name of capped) {
		const tool = byName.get(name);
		if (!tool) {
			missing.push(name);
			continue;
		}
		sections.push(
			`### ${tool.name}\n${tool.description ?? tool.name}\n\nParameters schema:\n${JSON.stringify(serializeToolSchema(tool.parameters), null, 2)}`,
		);
	}
	if (missing.length > 0) sections.push(`Unknown or inactive tools: ${missing.join(", ")}`);
	if (names.length > MAX_INFO_TOOLS_PER_CALL) {
		sections.push(`Note: truncated to first ${MAX_INFO_TOOLS_PER_CALL} requested tools (${names.length} requested).`);
	}
	return {
		content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
		isError: missing.length === capped.length,
	};
}

/** Validate and parse a bridge_call_tool payload against currently authorized Pi tools. */
export function parseBridgeCallRequest(
	raw: Record<string, unknown>,
	authorized: readonly BridgeToolInfo[],
): { ok: true; name: string; args: Record<string, unknown> } | { ok: false; error: string } {
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	if (!name) return { ok: false, error: "Error: name must be a non-empty string" };
	if (BRIDGE_INTERNAL_TOOLS.has(name) || !authorized.some((t) => t.name === name)) {
		return { ok: false, error: `Pi tool ${name} is not active or not exposed to Antigravity` };
	}
	const rawJson = raw.arguments_json;
	if (rawJson === undefined || rawJson === null || rawJson === "") {
		return { ok: true, name, args: {} };
	}
	if (typeof rawJson === "object" && !Array.isArray(rawJson)) {
		return { ok: true, name, args: rawJson as Record<string, unknown> };
	}
	if (typeof rawJson !== "string") {
		return { ok: false, error: "Error: arguments_json must be a stringified JSON object" };
	}
	try {
		const parsed = JSON.parse(rawJson) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, error: "Error: arguments_json must decode to a JSON object" };
		}
		return { ok: true, name, args: parsed as Record<string, unknown> };
	} catch (err) {
		return { ok: false, error: `Error: invalid arguments_json (${err instanceof Error ? err.message : String(err)})` };
	}
}
