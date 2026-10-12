// Secret guard: hostile-repo hygiene for material that leaves the machine.
// Paths that are secrets by name never inline; everything that does inline
// passes a redaction pass. Pure string/path work.
import { describe, expect, it } from "vitest";
import { isSecretPath, redactText, SECRETS_WITHHELD_MARK } from "../src/secrets.js";

describe("isSecretPath", () => {
	it("withholds env files, keys, and credential stores", () => {
		for (const p of [
			".env",
			".env.local",
			"config/.env.production",
			"server.pem",
			"keys/id_rsa",
			"keys/id_ed25519",
			"certs/server.key",
			"keys/id_rsa.pub", // key material family; cheap to over-withhold
			".npmrc",
			"aws/credentials.json",
			".git-credentials",
			"infra/prod.tfstate",
			".netrc",
		]) {
			expect(isSecretPath(p), p).toBe(true);
		}
	});

	it("leaves ordinary source alone", () => {
		for (const p of ["src/index.ts", "env.ts", "tokens.md", "credential-parser.spec.ts"]) {
			expect(isSecretPath(p), p).toBe(false);
		}
	});
});

describe("redactText", () => {
	it("redacts private key blocks wholesale", () => {
		const text = [
			"before",
			"-----BEGIN RSA PRIVATE KEY-----",
			"abc123secretmaterial",
			"-----END RSA PRIVATE KEY-----",
			"after",
		].join("\n");
		const out = redactText(text);
		expect(out).toContain("before");
		expect(out).toContain("after");
		expect(out).not.toContain("abc123secretmaterial");
		expect(out).toContain(SECRETS_WITHHELD_MARK);
	});

	it("redacts common token shapes", () => {
		const out = redactText(
			"token: ghp_abcdef1234567890 key sk-proj-abcdef123456 xoxb-synthetic-token-value AKIAIOSFODNN7EXAMPLE",
		);
		expect(out).not.toContain("ghp_abcdef1234567890");
		expect(out).not.toContain("sk-proj-abcdef123456");
		expect(out).not.toContain("xoxb-synthetic-token-value");
		expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});

	it("redacts URL basic-auth, bearer headers, and live keys", () => {
		const out = redactText(
			"postgres://admin:Sup3rS3cret@db.internal/x\nAuthorization: Bearer abcdef123456\nsk_live_abcdef123456 npm_abcdef123456",
		);
		expect(out).not.toContain("Sup3rS3cret");
		expect(out).toContain("admin:");
		expect(out).not.toContain("abcdef123456");
	});

	it("redacts URL basic-auth, bearer headers, and live keys", () => {
		const out = redactText(
			"postgres://admin:Sup3rS3cret@db.internal/x\nAuthorization: Bearer abcdef123456\nsk_live_abcdef123456 npm_abcdef123456",
		);
		expect(out).not.toContain("Sup3rS3cret");
		expect(out).toContain("admin:");
		expect(out).not.toContain("abcdef123456");
	});

	it("still redacts bare sk- token shapes with dashed segments", () => {
		expect(redactText('"sk-proj-abcdef123456_QrSt"')).not.toContain("abcdef123456");
	});

	it("redacts assignment-style credentials without eating ordinary code", () => {
		const out = redactText('const password = "hunter2hunter2";\nconst retries = 3;');
		expect(out).not.toContain("hunter2hunter2");
		expect(out).toContain("const retries = 3;");
	});

	it("leaves plain code untouched", () => {
		const code = "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
		expect(redactText(code)).toBe(code);
	});
});
