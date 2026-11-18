/** Model-switch handoff toast (UI only): the message shown when the user
 *  lands on an antigravity bridge model that has no bound agy conversation,
 *  telling them pi-side context will re-deliver into the fresh conversation.
 *  Returns null when the toast must stay silent. */

const BRIDGE_API = "agy-bridge";

export function handoffToast(input: {
	api: string | undefined;
	digestEnabled: boolean;
	bound: boolean;
	hasContext: boolean;
	source: "set" | "cycle" | "restore";
}): string | null {
	if (input.source === "restore") return null;
	if (input.api !== BRIDGE_API) return null;
	if (!input.digestEnabled) return null;
	if (input.bound) return null;
	if (!input.hasContext) return null;
	return "handoff context will ship to the new agy conversation";
}
