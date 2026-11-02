import { describe, expect, it } from "vitest";
import { StringEnum } from "../extensions/string-enum.js";

describe("StringEnum wire format", () => {
	it("emits the plain string-enum schema Google-compatible providers accept", () => {
		// GLM/Google-style APIs reject anyOf/const enum schemas; the wire must
		// stay `{ type: "string", enum: [...] }` with nothing else added.
		const schema = StringEnum(["working", "staged"] as const, { description: "Diff mode." });
		expect(schema).toEqual({ type: "string", enum: ["working", "staged"], description: "Diff mode." });
		expect(schema).not.toHaveProperty("anyOf");
		expect(schema).not.toHaveProperty("const");
	});
});
