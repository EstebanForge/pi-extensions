import { describe, expect, it } from "vitest";
import factory from "../extensions/agentmemory/index.js";

describe("pi-agentmemory extension entry", () => {
  it("registers the memory_health tool", async () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const pi: any = new Proxy(
      {
        registerTool: (def: any) => void tools.push(def?.name),
        registerCommand: (name: string) => void commands.push(name),
        getFlag: () => undefined,
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
      {
        get(target, prop) {
          return prop in target ? (target as any)[prop] : () => {};
        },
      },
    );

    await factory(pi);

    expect(tools).toContain("memory_health");
  });
});
