/**
 * pi-hostname — Machine hostname in the Pi footer.
 *
 * Shows `💻 <hostname>` as the first item of the footer status line (bottom left), so you always know which machine a session runs on when juggling several remote shells.
 *
 * Ordering: the built-in footer renders all extension statuses (set via ctx.ui.setStatus) on one line, sorted alphabetically by key. The "0-" prefix on STATUS_KEY pins this item to the first slot, ahead of letter keys such as "agentmemory" or "codegraph".
 */
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Footer status key. Numeric prefix = sorts first (footer sorts by key). */
export const STATUS_KEY = "0-hostname";

/**
 * Footer emoji. U+1F4BB has default emoji presentation, so it renders wide in any terminal without needing a variation selector.
 */
export const HOSTNAME_EMOJI = "💻";

/**
 * Normalize an OS hostname for footer display: drop a trailing dot, strip any DNS domain (first label only). "mini.local." -> "mini".
 */
export function formatHostname(raw: string): string {
	const host = raw.replace(/\.$/, "").split(".")[0] ?? raw;
	return host;
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const label = `${HOSTNAME_EMOJI} ${formatHostname(os.hostname())}`;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", label));
	});
}
