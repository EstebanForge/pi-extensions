const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function usesPlaintextBearerAuth(
  baseUrl: string,
  secret?: string,
): boolean {
  if (!secret) return false;
  try {
    const parsed = new URL(baseUrl);
    return (
      parsed.protocol === "http:" &&
      !LOOPBACK_HOSTS.has(normalizedHostname(parsed.hostname))
    );
  } catch {
    return false;
  }
}

export function plaintextBearerAuthMessage(baseUrl: string): string {
  return `agentmemory: AGENTMEMORY_SECRET is configured for plaintext HTTP to ${baseUrl}. Bearer tokens and memory payloads can be observed on the network; use HTTPS or an SSH tunnel.`;
}

export function createPlaintextBearerAuthGuard(
  warn: (message: string) => void = (message) => console.warn(message),
  env?: { AGENTMEMORY_REQUIRE_HTTPS?: string },
): (baseUrl: string, secret?: string) => void {
  let warned = false;
  return (baseUrl, secret) => {
    if (!usesPlaintextBearerAuth(baseUrl, secret)) return;
    const message = plaintextBearerAuthMessage(baseUrl);
    if ((env || process.env).AGENTMEMORY_REQUIRE_HTTPS === "1")
      throw new Error(message);
    if (!warned) {
      warned = true;
      warn(message);
    }
  };
}

// Shared singleton + chat-routed sink.
//
// Two entry points trip this guard during session_start: the host extension
// (index.ts, via callAgentMemory -> refreshStatus -> getHealth) and the server
// launcher (server.ts, via ensureServer -> isServerHealthy). Giving each its
// own guard instance printed the warning twice, and the default console.warn
// sink lands on stderr, which pi's TUI pins above the input for the whole
// session (the pi-antigravity-bridge extension hit and fixed the same bug by
// routing through ctx.ui.notify). The shared singleton here dedupes to one
// warning per session, and an injected ui.notify sink turns it into an
// ephemeral toast that fades instead of a permanent stderr line. Headless
// modes register no sink and fall back to console.warn. Call
// resetPlaintextBearerAuthWarning() at session_start so each session can
// surface the warning once.
export type PlaintextBearerAuthNotifySink = (
  message: string,
  level: "info" | "warning" | "error",
) => void;

let plaintextBearerAuthNotifySink: PlaintextBearerAuthNotifySink | null = null;
let plaintextBearerAuthWarned = false;

export function setPlaintextBearerAuthNotifySink(
  sink: PlaintextBearerAuthNotifySink | null,
): void {
  plaintextBearerAuthNotifySink = sink;
}

export function resetPlaintextBearerAuthWarning(): void {
  plaintextBearerAuthWarned = false;
}

export function guardPlaintextBearerAuth(
  baseUrl: string,
  secret?: string,
): void {
  if (!usesPlaintextBearerAuth(baseUrl, secret)) return;
  const message = plaintextBearerAuthMessage(baseUrl);
  if (process.env.AGENTMEMORY_REQUIRE_HTTPS === "1") throw new Error(message);
  if (plaintextBearerAuthWarned) return;
  plaintextBearerAuthWarned = true;
  if (plaintextBearerAuthNotifySink)
    plaintextBearerAuthNotifySink(message, "warning");
  else console.warn(message);
}
