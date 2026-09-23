import type { BridgeTools } from "./config.js";

export interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters?: object;
	sourceInfo?: { source?: string };
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
		tool.name !== "AskAntigravity" && tool.name !== "antigravity" &&
		tool.name !== "agy_web_search" && tool.name !== "agy_read_url" &&
		tool.name !== "bridge_poll_result" && tool.name !== "activate_skill" &&
		(mode === "mcp"
			? /pi-mcp-adapter/.test(tool.sourceInfo?.source ?? "")
			: tool.sourceInfo?.source !== "builtin"),
	);
}
