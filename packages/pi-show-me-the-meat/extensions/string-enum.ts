import { Type } from "typebox";

// Plain `{ type: "string", enum: [...] }` with TypeBox statics restored:
// Google-compatible providers reject anyOf/const enum schemas, and pi-ai
// 1.5's StringEnum lost the TypeBox typing that let Static<> infer unions.
export function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
	});
}
