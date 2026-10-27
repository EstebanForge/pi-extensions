import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	StreamSanitizer,
	sanitizeSystemMessage,
} from "../src/stream-sanitizer.js";

describe("StreamSanitizer", () => {
	it("passes normal streamed text through unchanged", () => {
		const s = new StreamSanitizer();
		const chunks = ["Hello ", "world! ", "This is normal text."];
		const output = chunks.map((c) => s.push(c)).join("") + s.flush();
		assert.equal(output, "Hello world! This is normal text.");
	});

	it("strips a complete <SYSTEM_MESSAGE> block in a single chunk", () => {
		const s = new StreamSanitizer();
		const input =
			'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=... task id "123" finished with result: ok\n</SYSTEM_MESSAGE>\nNow I will run tests.';
		const output = s.push(input) + s.flush();
		assert.equal(output, "Now I will run tests.");
	});

	it("strips multiple <SYSTEM_MESSAGE> blocks back-to-back", () => {
		const s = new StreamSanitizer();
		const input =
			"The following is a <SYSTEM_MESSAGE>1</SYSTEM_MESSAGE>The following is a <SYSTEM_MESSAGE>2</SYSTEM_MESSAGE>All done!";
		const output = s.push(input) + s.flush();
		assert.equal(output, "All done!");
	});

	it("strips <SYSTEM_MESSAGE> split across multiple streaming chunks", () => {
		const s = new StreamSanitizer();
		const chunks = [
			"The ",
			"following is a ",
			"<SYSTEM_MESSAGE>",
			" not actually sent by the user.\n\n",
			"<SYSTEM_MESSAGE>\n",
			"task-264 finished with code 0\n",
			"</SYS",
			"TEM_MESSAGE>\n",
			"Result is ready.",
		];
		let collected = "";
		for (const chunk of chunks) {
			collected += s.push(chunk);
		}
		collected += s.flush();
		assert.equal(collected, "Result is ready.");
	});

	it("correctly preserves text that shares a partial prefix with START_MARKER", () => {
		const s = new StreamSanitizer();
		// "The " matches prefix of START_MARKER, but is followed by "other book"
		const c1 = s.push("The ");
		assert.equal(c1, ""); // buffered tentatively
		const c2 = s.push("other book is good.");
		assert.equal(c2, "The other book is good.");
		assert.equal(s.flush(), "");
	});

	it("flushes pending partial prefix buffer at end of stream", () => {
		const s = new StreamSanitizer();
		const c1 = s.push("Look at The ");
		assert.equal(c1, "Look at ");
		const flushed = s.flush();
		assert.equal(flushed, "The ");
	});

	it("fails open and emits unclosed system message on flush", () => {
		const s = new StreamSanitizer();
		const c1 = s.push("The following is a <SYSTEM_MESSAGE> unterminated message");
		assert.equal(c1, "");
		const flushed = s.flush();
		assert.equal(flushed, "The following is a <SYSTEM_MESSAGE> unterminated message");
	});

	it("preserves paragraphs while stripping middle system message", () => {
		const s = new StreamSanitizer();
		const chunks = [
			"First line.\n\n",
			"The following is a <SYSTEM_MESSAGE>task done</SYSTEM_MESSAGE>\n\n",
			"Second line.",
		];
		const output = chunks.map((c) => s.push(c)).join("") + s.flush();
		assert.equal(output, "First line.\n\nSecond line.");
	});
});

describe("sanitizeSystemMessage (static)", () => {
	it("strips system message block and preserves surrounding text", () => {
		const raw =
			"I checked status.\n\nThe following is a <SYSTEM_MESSAGE>\n[Message] task done\n</SYSTEM_MESSAGE>\n\nAll clear.";
		const cleaned = sanitizeSystemMessage(raw);
		assert.equal(cleaned, "I checked status.\n\nAll clear.");
	});

	it("leaves normal text untouched", () => {
		const raw = "Here is some code with <SYSTEM_MESSAGE> tag mentioned in text.";
		assert.equal(sanitizeSystemMessage(raw), raw);
	});
});
