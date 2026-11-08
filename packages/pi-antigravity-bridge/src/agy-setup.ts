import { agyAuthenticationMessage, agyInstallCommand, installAgyCli } from "./agy-install.js";

export interface AgySetupUi {
	confirm: (title: string, body: string) => Promise<boolean>;
	notify: (message: string, level: "info" | "warning") => void;
	setStatus: (id: string, text?: string) => void;
}

export function createAgySetupOffer(opts: {
	ui: AgySetupUi;
	binaryOverride?: string;
	install?: typeof installAgyCli;
	missingMessage: () => string;
	log: (event: string, data: unknown, level: "warn" | "info") => void;
}): () => Promise<void> {
	let offered = false;
	let inFlight: Promise<void> | null = null;
	const install = opts.install ?? installAgyCli;
	const notify = (message: string, level: "info" | "warning") => {
		try {
			opts.ui.notify(message, level);
		} catch (err) {
			opts.log("agy-install", { error: String(err) }, "warn");
		}
	};

	return () => {
		if (inFlight) return inFlight;
		if (offered) return Promise.resolve();
		offered = true;
		inFlight = (async () => {
			try {
				if (opts.binaryOverride) {
					notify(
						`AGY_BIN points to ${opts.binaryOverride}, which is missing or unsupported. Fix or unset AGY_BIN. The official installer cannot change this override.`,
						"warning",
					);
					return;
				}
				const spec = agyInstallCommand();
				const command = [spec.command, ...spec.args].join(" ");
				const approved = await opts.ui.confirm(
					"Antigravity CLI required",
					`Both engines require the agy CLI. Run Google's official installer now?\n\n${command}`,
				);
				if (!approved) {
					notify(opts.missingMessage(), "warning");
					return;
				}
				opts.ui.setStatus("agy-install", "Installing Antigravity CLI…");
				const result = await install();
				if (!result.ok) {
					opts.log("agy-install", { error: result.error }, "warn");
					notify(`Antigravity CLI installation failed: ${result.error}\n${opts.missingMessage()}`, "warning");
					return;
				}
				notify(`Antigravity CLI installed. ${agyAuthenticationMessage()}`, "info");
			} catch (err) {
				opts.log("agy-install", { error: String(err) }, "warn");
				notify(`Antigravity CLI setup failed: ${String(err)}\n${opts.missingMessage()}`, "warning");
			} finally {
				try {
					opts.ui.setStatus("agy-install", undefined);
				} catch {
					// UI teardown must not reject a shared setup promise.
				}
				inFlight = null;
			}
		})();
		return inFlight;
	};
}
