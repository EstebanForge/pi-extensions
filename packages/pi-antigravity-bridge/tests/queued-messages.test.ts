import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	ensureQueuedMessagesDefaults,
	ensureQueuedMessagesInFile,
	QUEUED_MESSAGES_SEND_IMMEDIATELY,
} from "../src/queued-messages.js";

const createdDirs: string[] = [];

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queued-messages-test-"));
	createdDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of createdDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
	createdDirs.length = 0;
});

describe("queued-messages ensureQueuedMessagesInFile", () => {
	it("creates file and sets queuedMessages to send-immediately when absent", () => {
		const dir = tmpDir();
		const file = path.join(dir, "sub", "settings.json");
		const res = ensureQueuedMessagesInFile(file);
		assert.equal(res.updated, true);
		assert.equal(res.value, QUEUED_MESSAGES_SEND_IMMEDIATELY);

		const content = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(content.queuedMessages, "send-immediately");
		const mode = fs.statSync(file).mode & 0o777;
		assert.equal(mode, 0o600);
	});

	it("preserves existing settings and sets queuedMessages when missing", () => {
		const dir = tmpDir();
		const file = path.join(dir, "settings.json");
		fs.writeFileSync(file, JSON.stringify({ auth: { type: "oauth-personal" }, model: "gemini" }, null, 2));

		const res = ensureQueuedMessagesInFile(file);
		assert.equal(res.updated, true);
		assert.equal(res.value, QUEUED_MESSAGES_SEND_IMMEDIATELY);

		const content = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(content.queuedMessages, "send-immediately");
		assert.deepEqual(content.auth, { type: "oauth-personal" });
		assert.equal(content.model, "gemini");
	});

	it("does not overwrite if queuedMessages is already configured", () => {
		const dir = tmpDir();
		const file = path.join(dir, "settings.json");
		fs.writeFileSync(file, JSON.stringify({ queuedMessages: "queue" }, null, 2));

		const res = ensureQueuedMessagesInFile(file);
		assert.equal(res.updated, false);
		assert.equal(res.value, "queue");

		const content = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(content.queuedMessages, "queue");
	});

	it("updates when queuedMessages is empty string or whitespace", () => {
		const dir = tmpDir();
		const file = path.join(dir, "settings.json");
		fs.writeFileSync(file, JSON.stringify({ queuedMessages: "   ", model: "flash" }));

		const res = ensureQueuedMessagesInFile(file);
		assert.equal(res.updated, true);
		assert.equal(res.value, QUEUED_MESSAGES_SEND_IMMEDIATELY);

		const content = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(content.queuedMessages, "send-immediately");
		assert.equal(content.model, "flash");
	});

	it("does NOT clobber file if JSON is malformed", () => {
		const dir = tmpDir();
		const file = path.join(dir, "settings.json");
		const malformed = "{\n  auth: { type: oauth-personal }, // trailing comma\n}";
		fs.writeFileSync(file, malformed);

		const res = ensureQueuedMessagesInFile(file);
		assert.equal(res.updated, false);
		assert.ok(res.error?.includes("malformed JSON"));

		const after = fs.readFileSync(file, "utf8");
		assert.equal(after, malformed);
	});

	it("does NOT clobber file if parsed JSON is an array or non-object", () => {
		const dir = tmpDir();
		const file = path.join(dir, "settings.json");
		fs.writeFileSync(file, JSON.stringify(["item1", "item2"]));

		const res = ensureQueuedMessagesInFile(file);
		assert.equal(res.updated, false);
		assert.ok(res.error?.includes("not a JSON object"));

		const after = fs.readFileSync(file, "utf8");
		assert.equal(after, JSON.stringify(["item1", "item2"]));
	});

	it("resolves symlinks and updates the target without replacing the link", () => {
		const dir = tmpDir();
		const targetFile = path.join(dir, "real-settings.json");
		const linkFile = path.join(dir, "link-settings.json");
		fs.writeFileSync(targetFile, JSON.stringify({ auth: { type: "oauth-personal" } }));
		fs.symlinkSync(targetFile, linkFile);

		const res = ensureQueuedMessagesInFile(linkFile);
		assert.equal(res.updated, true);

		assert.ok(fs.lstatSync(linkFile).isSymbolicLink());
		const parsed = JSON.parse(fs.readFileSync(targetFile, "utf8"));
		assert.equal(parsed.queuedMessages, "send-immediately");
	});

	it("respects onlyIfDirExists flag", () => {
		const dir = tmpDir();
		const nonexistentDir = path.join(dir, "missing-folder");
		const file = path.join(nonexistentDir, "settings.json");

		const res = ensureQueuedMessagesInFile(file, { onlyIfDirExists: true });
		assert.equal(res.updated, false);
		assert.equal(fs.existsSync(nonexistentDir), false);
	});
});

describe("queued-messages ensureQueuedMessagesDefaults", () => {
	it("ensures defaults for both cli and acp settings files", () => {
		const dir = tmpDir();
		const cliFile = path.join(dir, "cli", "settings.json");
		const acpFile = path.join(dir, "acp", "settings.json");

		const report = ensureQueuedMessagesDefaults({
			cliSettingsPath: cliFile,
		acpSettingsPath: acpFile,
		});

		assert.equal(report.cli.updated, true);
		assert.equal(report.acp.updated, true);

		const cliJson = JSON.parse(fs.readFileSync(cliFile, "utf8"));
		const acpJson = JSON.parse(fs.readFileSync(acpFile, "utf8"));
		assert.equal(cliJson.queuedMessages, "send-immediately");
		assert.equal(acpJson.queuedMessages, "send-immediately");
	});
});
