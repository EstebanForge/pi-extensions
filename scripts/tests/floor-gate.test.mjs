// Gates for the release-time floor checks, all offline and deterministic:
// fetchFloor/hasVersion are injected so the suite never touches the network.
// The bridge case (dialogChoice imported over a 0.1.1 floor that lacks it)
// is the regression this whole module exists to catch.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkFloors, parseFloor } from "../lib/floor-gate.mjs";

const tmpRoot = mkdtempSync(join(tmpdir(), "floor-gate-test-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

// Builds a stand-in for the published floor tarball: <dir>/package.json with
// an exports map at ./src/index.ts plus whatever src files the test wants.
const makeFloor = (dep, files, pkg = {}) => {
  const dir = join(tmpRoot, dep.replaceAll("/", "_"), String(Math.random()).slice(2));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: dep, version: "0.0.0", main: "./src/index.ts", exports: { ".": "./src/index.ts" }, ...pkg }),
  );
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};

const makeConsumer = (name, files, deps) => {
  const dir = join(tmpRoot, "consumer", name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", files: ["src", "extensions"], dependencies: deps }),
  );
  return dir;
};

const fetcherFor = (floors) => async (dep, floor, dest) => {
  const fixture = floors[`${dep}@${floor}`];
  if (!fixture) throw new Error(`no fixture for ${dep}@${floor}`);
  cpSync(fixture, dest, { recursive: true });
};
const okVersion = async () => true;
const deadRegistry = async () => {
  throw Object.assign(new Error("E404"), { code: "E404" });
};

const noWorkspace = () => null;

describe("parseFloor", () => {
  it("accepts caret, tilde, and exact ranges", () => {
    expect(parseFloor("^0.1.2")).toBe("0.1.2");
    expect(parseFloor("~1.2.3")).toBe("1.2.3");
    expect(parseFloor("1.2.3")).toBe("1.2.3");
  });
  it("refuses ranges without a single floor", () => {
    for (const range of [">=1.0.0", "*", "^0.1.0-beta.1", "workspace:*", "latest", "^0.1"]) {
      expect(parseFloor(range)).toBeNull();
    }
  });
});

describe("checkFloors", () => {
  it("catches the bridge regression: named import missing from the floor", async () => {
    const floor = makeFloor("@estebanforge/pi-tui-dialogs", {
      "src/index.ts": "export { dialogMenu } from \"./menu.js\";\n",
      "src/menu.ts": "export function dialogMenu() {}\n",
    });
    const pkgDir = makeConsumer(
      "pi-bridge",
      { "src/engine-picker.ts": "import { dialogChoice } from \"@estebanforge/pi-tui-dialogs\";\n" },
      { "@estebanforge/pi-tui-dialogs": "^0.1.1" },
    );
    const problems = await checkFloors({
      rootDir: tmpRoot,
      pkgDir,
      fetchFloor: fetcherFor({ "@estebanforge/pi-tui-dialogs@0.1.1": floor }),
      hasVersion: okVersion,
      workspaceVersion: noWorkspace,
    });
    expect(problems.join("\n")).toContain("dialogChoice");
    expect(problems.join("\n")).toContain("0.1.1");
  });

  it("passes when the floor exports everything the code imports", async () => {
    const floor = makeFloor("@estebanforge/kit", {
      "src/index.ts": "export { dialogMenu, type DialogRow } from \"./menu.js\";\n",
      "src/menu.ts": "export interface DialogRow { label: string }\nexport function dialogMenu() {}\n",
    });
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import { dialogMenu, type DialogRow } from \"@estebanforge/kit\";\n" },
      { "@estebanforge/kit": "^0.1.1" },
    );
    expect(
      await checkFloors({
        rootDir: tmpRoot,
        pkgDir,
        fetchFloor: fetcherFor({ "@estebanforge/kit@0.1.1": floor }),
        hasVersion: okVersion,
        workspaceVersion: noWorkspace,
      }),
    ).toEqual([]);
  });

  it("resolves export * chains, aliases, and .js-to-.ts specifiers", async () => {
    const floor = makeFloor("@estebanforge/kit", {
      "src/index.ts": "export * from \"./menu.js\";\nexport { input as prompt } from \"./input.js\";\n",
      "src/menu.ts": "export function dialogMenu() {}\n",
      "src/input.ts": "export const input = 1;\n",
    });
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import { dialogMenu, prompt } from \"@estebanforge/kit\";\n" },
      { "@estebanforge/kit": "0.1.1" },
    );
    expect(
      await checkFloors({
        rootDir: tmpRoot,
        pkgDir,
        fetchFloor: fetcherFor({ "@estebanforge/kit@0.1.1": floor }),
        hasVersion: okVersion,
        workspaceVersion: noWorkspace,
      }),
    ).toEqual([]);
  });

  it("fails a missing type-only import", async () => {
    const floor = makeFloor("@estebanforge/kit", { "src/index.ts": "export function f() {}\n" });
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import type { MissingRow } from \"@estebanforge/kit\";\n" },
      { "@estebanforge/kit": "^0.1.1" },
    );
    const problems = await checkFloors({
      rootDir: tmpRoot,
      pkgDir,
      fetchFloor: fetcherFor({ "@estebanforge/kit@0.1.1": floor }),
      hasVersion: okVersion,
      workspaceVersion: noWorkspace,
    });
    expect(problems.join("\n")).toContain("MissingRow");
  });

  it("fails a default import when the floor has no default export", async () => {
    const floor = makeFloor("@estebanforge/kit", { "src/index.ts": "export const a = 1;\n" });
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import kit from \"@estebanforge/kit\";\n" },
      { "@estebanforge/kit": "^0.1.1" },
    );
    const problems = await checkFloors({
      rootDir: tmpRoot,
      pkgDir,
      fetchFloor: fetcherFor({ "@estebanforge/kit@0.1.1": floor }),
      hasVersion: okVersion,
      workspaceVersion: noWorkspace,
    });
    expect(problems).toHaveLength(1);
  });

  it("fails an import of a dependency package.json does not declare", async () => {
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import { x } from \"@estebanforge/undeclared\";\n" },
      {},
    );
    const problems = await checkFloors({
      rootDir: tmpRoot,
      pkgDir,
      fetchFloor: fetcherFor({}),
      hasVersion: okVersion,
      workspaceVersion: noWorkspace,
    });
    expect(problems.join("\n")).toContain("does not declare");
  });

  it("refuses ranges without a single floor", async () => {
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import { x } from \"@estebanforge/kit\";\n" },
      { "@estebanforge/kit": ">=1.0.0" },
    );
    const problems = await checkFloors({
      rootDir: tmpRoot,
      pkgDir,
      fetchFloor: fetcherFor({}),
      hasVersion: okVersion,
      workspaceVersion: noWorkspace,
    });
    expect(problems.join("\n")).toContain("single floor");
  });

  it("refuses a floor above the workspace copy (npm run check would test the wrong code)", async () => {
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import { x } from \"@estebanforge/kit\";\n" },
      { "@estebanforge/kit": "^9.9.9" },
    );
    const problems = await checkFloors({
      rootDir: tmpRoot,
      pkgDir,
      fetchFloor: fetcherFor({}),
      hasVersion: okVersion,
      workspaceVersion: (dep) => (dep.endsWith("kit") ? "0.1.2" : null),
    });
    expect(problems.join("\n")).toContain("above");
  });

  it("reports a floor that is not on npm as publish-the-library-first", async () => {
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import { x } from \"@estebanforge/kit\";\n" },
      { "@estebanforge/kit": "^0.1.0" },
    );
    const problems = await checkFloors({
      rootDir: tmpRoot,
      pkgDir,
      fetchFloor: fetcherFor({}),
      hasVersion: deadRegistry,
      workspaceVersion: noWorkspace,
    });
    expect(problems.join("\n")).toContain("not on npm");
  });

  it("reports an unreachable registry as network, not missing", async () => {
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import { x } from \"@estebanforge/kit\";\n" },
      { "@estebanforge/kit": "^0.1.1" },
    );
    const problems = await checkFloors({
      rootDir: tmpRoot,
      pkgDir,
      fetchFloor: fetcherFor({}),
      hasVersion: async () => {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      },
      workspaceVersion: noWorkspace,
    });
    expect(problems.join("\n")).toContain("cannot reach");
  });

  it("treats a subpath import as its package, and a missing subpath export as unresolvable", async () => {
    const floor = makeFloor("@estebanforge/kit", { "src/index.ts": "export const a = 1;\n" });
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import { tool } from \"@estebanforge/kit/sub\";\n" },
      { "@estebanforge/kit": "^0.1.1" },
    );
    const problems = await checkFloors({
      rootDir: tmpRoot,
      pkgDir,
      fetchFloor: fetcherFor({ "@estebanforge/kit@0.1.1": floor }),
      hasVersion: okVersion,
      workspaceVersion: noWorkspace,
    });
    // Not "does not declare" (the AST specifier maps to the package), but
    // the floor's exports map has no ./sub, so the probe must flag 2307.
    expect(problems.join("\n")).not.toContain("does not declare");
    expect(problems.join("\n")).toContain("does not resolve");
  });

  it("resolves the floor's external re-exports through the ancestor node_modules", async () => {
    // Mirrors the production layout: the probe dir sits under
    // <rootDir>/node_modules/.cache, so a peer living in <rootDir>/node_modules
    // resolves without any symlinking.
    const peerDir = join(tmpRoot, "node_modules", "@external", "peer");
    mkdirSync(peerDir, { recursive: true });
    writeFileSync(
      join(peerDir, "package.json"),
      JSON.stringify({ name: "@external/peer", version: "1.0.0", main: "./index.ts", exports: { ".": "./index.ts" } }),
    );
    writeFileSync(join(peerDir, "index.ts"), "export function shared() {}\n");
    const floor = makeFloor("@estebanforge/kit", {
      "src/index.ts": "export * from \"@external/peer\";\n",
    }, { peerDependencies: { "@external/peer": "^1.0.0" } });
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import { shared } from \"@estebanforge/kit\";\n" },
      { "@estebanforge/kit": "^0.1.1" },
    );
    expect(
      await checkFloors({
        rootDir: tmpRoot,
        pkgDir,
        fetchFloor: fetcherFor({ "@estebanforge/kit@0.1.1": floor }),
        hasVersion: okVersion,
        workspaceVersion: noWorkspace,
      }),
    ).toEqual([]);
  });

  it("skips an optional dependency whose floor is absent from npm", async () => {
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import { x } from \"@estebanforge/opt\";\n" },
      {},
    );
    // makeConsumer only writes `dependencies`; add the optional block here.
    const pkgPath = join(pkgDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.optionalDependencies = { "@estebanforge/opt": "^0.1.0" };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    expect(
      await checkFloors({
        rootDir: tmpRoot,
        pkgDir,
        fetchFloor: fetcherFor({}),
        hasVersion: deadRegistry,
        workspaceVersion: noWorkspace,
      }),
    ).toEqual([]);
  });

  it("probes a peer dependency floor like a regular one", async () => {
    const floor = makeFloor("@estebanforge/kit", { "src/index.ts": "export const old = 1;\n" });
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import { fresh } from \"@estebanforge/kit\";\n" },
      {},
    );
    const pkgPath = join(pkgDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.peerDependencies = { "@estebanforge/kit": "^0.1.1" };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    const problems = await checkFloors({
      rootDir: tmpRoot,
      pkgDir,
      fetchFloor: fetcherFor({ "@estebanforge/kit@0.1.1": floor }),
      hasVersion: okVersion,
      workspaceVersion: noWorkspace,
    });
    expect(problems.join("\n")).toContain("fresh");
  });

  it("fails a namespace import whose used member is missing from the floor", async () => {
    const floor = makeFloor("@estebanforge/kit", { "src/index.ts": "export const old = 1;\n" });
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import * as kit from \"@estebanforge/kit\";\n\nexport function run() {\n  return kit.dialogChoice();\n}\n" },
      { "@estebanforge/kit": "^0.1.1" },
    );
    const problems = await checkFloors({
      rootDir: tmpRoot,
      pkgDir,
      fetchFloor: fetcherFor({ "@estebanforge/kit@0.1.1": floor }),
      hasVersion: okVersion,
      workspaceVersion: noWorkspace,
    });
    expect(problems.join("\n")).toContain("dialogChoice");
  });

  it("passes a namespace import whose used member exists in the floor", async () => {
    const floor = makeFloor("@estebanforge/kit", { "src/index.ts": "export function dialogChoice() {}\n" });
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import * as kit from \"@estebanforge/kit\";\n\nexport function run() {\n  return kit.dialogChoice();\n}\n" },
      { "@estebanforge/kit": "^0.1.1" },
    );
    expect(
      await checkFloors({
        rootDir: tmpRoot,
        pkgDir,
        fetchFloor: fetcherFor({ "@estebanforge/kit@0.1.1": floor }),
        hasVersion: okVersion,
        workspaceVersion: noWorkspace,
      }),
    ).toEqual([]);
  });

  it("does not value-probe members of a type-only namespace import", async () => {
    // Accepted limit: a type-only namespace lives in type space, so `void
    // kit.member` would be a bogus value probe. Resolution is still checked.
    const floor = makeFloor("@estebanforge/kit", { "src/index.ts": "export const a = 1;\n" });
    const pkgDir = makeConsumer(
      "pi-user",
      { "src/ui.ts": "import type * as kit from \"@estebanforge/kit\";\n\nexport type Row = kit.Row;\n" },
      { "@estebanforge/kit": "^0.1.1" },
    );
    expect(
      await checkFloors({
        rootDir: tmpRoot,
        pkgDir,
        fetchFloor: fetcherFor({ "@estebanforge/kit@0.1.1": floor }),
        hasVersion: okVersion,
        workspaceVersion: noWorkspace,
      }),
    ).toEqual([]);
  });

  it("ignores imports from non-workspace packages and unshipped test files", async () => {
    const pkgDir = makeConsumer(
      "pi-user",
      {
        "src/ui.ts": "import { useState } from \"react\";\nimport { dialogMenu } from \"@estebanforge/kit\";\n",
        "tests/ui.test.ts": "import { anything } from \"@estebanforge/kit\";\n",
      },
      { "@estebanforge/kit": "^0.1.1", "react": "^18.0.0" },
    );
    const floor = makeFloor("@estebanforge/kit", { "src/index.ts": "export function dialogMenu() {}\n" });
    expect(
      await checkFloors({
        rootDir: tmpRoot,
        pkgDir,
        fetchFloor: fetcherFor({ "@estebanforge/kit@0.1.1": floor }),
        hasVersion: okVersion,
        workspaceVersion: noWorkspace,
      }),
    ).toEqual([]);
  });
});
