// /agy tasks overlay: SelectList over one conversation's background tasks.
//
// UI mirrors the artifacts browser (engine-picker pattern). Watch-only:
// enter closes (the list IS the dashboard), r rescans, esc closes. Tails
// live in the command form: /agy tasks tail <id> — a log tail is chat
// content, not overlay content.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgyTask } from "./tasks.js";

export type TasksBrowserAction = { type: "rescan" } | { type: "close" };

export function taskItems(tasks: AgyTask[]): SelectItem[] {
	return tasks.map((t) => {
		const when = new Date(t.modifiedMs);
		const stamp = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
		const state = t.livenessKnown ? (t.active ? "ACTIVE" : "idle") : "liveness?";
		return {
			value: String(t.id),
			label: `#${t.id} · ${state}`,
			description: `${humanBytes(t.bytes)} · last write ${stamp}`,
		};
	});
}

function humanBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** Render the overlay. Resolves rescan (caller re-lists and reopens) or
 *  close. */
export async function showTasksBrowser(
	ctx: ExtensionUIContext,
	tasks: AgyTask[],
	livenessKnown: boolean,
): Promise<TasksBrowserAction> {
	const items = taskItems(tasks);
	return ctx.custom<TasksBrowserAction>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(
			new Text(theme.fg("accent", theme.bold(`Antigravity tasks (${tasks.length})`)), 1, 0),
		);
		if (!livenessKnown) {
			container.addChild(
				new Text(theme.fg("warning", "lsof not found; liveness unknown (install lsof for ACTIVE/idle)"), 1, 0),
			);
		}
		container.addChild(new Spacer(1));

		const list = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});
		list.onSelect = () => done({ type: "close" });
		list.onCancel = () => done({ type: "close" });
		container.addChild(list);

		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("dim", "↑↓ navigate · r rescan · esc close · /agy tasks tail <id> for a log"), 1, 0),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data.trim().toLowerCase() === "r") {
					done({ type: "rescan" });
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}, {
		overlay: true,
		overlayOptions: { anchor: "center" as const, width: 72, maxHeight: "85%" as const, margin: 1 },
	});
}
