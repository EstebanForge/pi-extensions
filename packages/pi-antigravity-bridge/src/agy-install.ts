import { spawn } from "node:child_process";
import { isAgyInstalled } from "./engine-picker.js";

export interface AgyInstallCommand {
	command: string;
	args: string[];
}

export function agyInstallCommand(platform: NodeJS.Platform = process.platform): AgyInstallCommand {
	if (platform === "win32") {
		return {
			command: "powershell.exe",
			args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://antigravity.google/cli/install.ps1 | iex"],
		};
	}
	// curl|bash under pipefail turned install.sh's early "already installed"
	// exit into curl write error 23, reported as a failed install (issue #19).
	// Download to a file first so a consumer early-exit cannot fake one.
	return {
		command: "bash",
		args: ["-c", "t=$(mktemp) && trap 'rm -f \"$t\"' EXIT && curl -fsSL https://antigravity.google/cli/install.sh -o \"$t\" && bash \"$t\""],
	};
}

export function agyAuthenticationMessage(): string {
	return "Run `agy` in your terminal and complete the Google sign-in. Restart pi afterwards.";
}

type InstallRunner = (command: AgyInstallCommand, timeoutMs: number) => Promise<{ code: number | null; output: string }>;

const defaultRunner: InstallRunner = ({ command, args }, timeoutMs) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		let output = "";
		let settled = false;
		const append = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-64_000);
		};
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			reject(err);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", fail);
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			resolve({ code, output: output.trim() });
		});
		const watchdog = setTimeout(() => {
			try {
				if (child.pid && process.platform === "win32") {
					const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
					killer.on("error", () => {});
					killer.unref();
				} else if (child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				// The process may have exited between the deadline and kill.
			}
			fail(new Error("Antigravity CLI installer exceeded 10 minutes"));
		}, timeoutMs);
	});

export async function installAgyCli(opts: {
	platform?: NodeJS.Platform;
	run?: InstallRunner;
	verify?: () => boolean | Promise<boolean>;
	timeoutMs?: number;
} = {}): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
	try {
		const result = await (opts.run ?? defaultRunner)(agyInstallCommand(opts.platform), opts.timeoutMs ?? 10 * 60_000);
		if (result.code !== 0) return { ok: false, error: result.output || `installer exited with code ${result.code ?? "unknown"}` };
		const verify = opts.verify ?? (() => isAgyInstalled(process.env.AGY_BIN || "agy"));
		if (!(await verify())) {
			// The installer output often names where agy already lives (the
			// already-installed notice); the tail turns the guidance actionable.
			const tail = result.output.split("\n").slice(-3).join("\n");
			return { ok: false, error: `installer finished, but agy is not available in this pi process; set AGY_BIN to the binary path or add its directory to PATH, then restart pi${tail ? `\n${tail}` : ""}` };
		}
		return { ok: true, output: result.output };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
