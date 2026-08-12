import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlaintextBearerAuthGuard,
  guardPlaintextBearerAuth,
  resetPlaintextBearerAuthWarning,
  setPlaintextBearerAuthNotifySink,
} from "../extensions/agentmemory/security.js";

// Non-loopback plaintext + secret is the configuration that trips the guard:
// the exact shape of the Unraid/NAS setup (http://whitebox:3111 + a secret).
const PLAINTEXT_URL = "http://whitebox:3111";
const SECRET = "test-secret";

beforeEach(() => {
  resetPlaintextBearerAuthWarning();
  setPlaintextBearerAuthNotifySink(null);
  delete process.env.AGENTMEMORY_REQUIRE_HTTPS;
});

afterEach(() => {
  resetPlaintextBearerAuthWarning();
  setPlaintextBearerAuthNotifySink(null);
  vi.restoreAllMocks();
});

describe("shared singleton guardPlaintextBearerAuth", () => {
  it("dedupes to one warning when two entry points trip it in the same session", () => {
    // Reproduces the original bug: index.ts and server.ts each constructed a
    // guard, so session_start printed the warning twice. The shared singleton
    // must collapse any number of calls within a session to a single warning.
    const sink = vi.fn();
    setPlaintextBearerAuthNotifySink(sink);

    guardPlaintextBearerAuth(PLAINTEXT_URL, SECRET); // index.ts path
    guardPlaintextBearerAuth(PLAINTEXT_URL, SECRET); // server.ts path

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenLastCalledWith(
      expect.stringContaining("AGENTMEMORY_SECRET is configured for plaintext HTTP"),
      "warning",
    );
  });

  it("routes through the ui.notify sink instead of console.warn when a sink is registered", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink = vi.fn();
    setPlaintextBearerAuthNotifySink(sink);

    guardPlaintextBearerAuth(PLAINTEXT_URL, SECRET);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to console.warn when no sink is registered (headless)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    guardPlaintextBearerAuth(PLAINTEXT_URL, SECRET);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("re-arms after resetPlaintextBearerAuthWarning so a new session can warn again", () => {
    const sink = vi.fn();
    setPlaintextBearerAuthNotifySink(sink);

    guardPlaintextBearerAuth(PLAINTEXT_URL, SECRET);
    expect(sink).toHaveBeenCalledTimes(1);

    // Same session: stays silent.
    guardPlaintextBearerAuth(PLAINTEXT_URL, SECRET);
    expect(sink).toHaveBeenCalledTimes(1);

    // Next session_start re-arms.
    resetPlaintextBearerAuthWarning();
    guardPlaintextBearerAuth(PLAINTEXT_URL, SECRET);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("does not warn for loopback http even with a secret", () => {
    const sink = vi.fn();
    setPlaintextBearerAuthNotifySink(sink);
    guardPlaintextBearerAuth("http://127.0.0.1:3111", SECRET);
    guardPlaintextBearerAuth("http://localhost:3111", SECRET);
    expect(sink).not.toHaveBeenCalled();
  });

  it("does not warn without a secret", () => {
    const sink = vi.fn();
    setPlaintextBearerAuthNotifySink(sink);
    guardPlaintextBearerAuth(PLAINTEXT_URL, undefined);
    expect(sink).not.toHaveBeenCalled();
  });

  it("throws when AGENTMEMORY_REQUIRE_HTTPS=1 (hard fail, not a warning)", () => {
    process.env.AGENTMEMORY_REQUIRE_HTTPS = "1";
    expect(() => guardPlaintextBearerAuth(PLAINTEXT_URL, SECRET)).toThrow(
      /plaintext HTTP/,
    );
  });
});

describe("createPlaintextBearerAuthGuard factory (still exported)", () => {
  it("dedupes within a single instance via its closure flag", () => {
    const warn = vi.fn();
    const guard = createPlaintextBearerAuthGuard(warn);
    guard(PLAINTEXT_URL, SECRET);
    guard(PLAINTEXT_URL, SECRET);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
