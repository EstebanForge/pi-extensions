import { describe, expect, it } from "vitest";
import { StringEnum } from "../lib/string-enum.js";

describe("StringEnum wire format", () => {
	it("emits the plain string-enum schema Google-compatible providers accept", () => {
		// GLM/Google-style APIs reject anyOf/const enum schemas; the wire must
		// stay `{ type: "string", enum: [...] }` with nothing else added.
		const schema = StringEnum(["oneDay", "oneWeek"] as const, { description: "Time range." });
		expect(schema).toEqual({ type: "string", enum: ["oneDay", "oneWeek"], description: "Time range." });
		expect(schema).not.toHaveProperty("anyOf");
		expect(schema).not.toHaveProperty("const");
	});
});
