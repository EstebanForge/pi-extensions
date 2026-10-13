// Release gate: a package's declared floor on every @estebanforge/*
// dependency must actually provide what the shipped code imports, and the
// floor must exist on npm. Deterministic form of the runbook rule that
// failed with bridge 1.8.1: it imported dialogChoice over a ^0.1.1 floor
// while the export only landed in 0.1.2, and consumers with a stale
// lockfile crashed at runtime.
//
// Verification runs against the real published artifact (`npm pack` of the
// floor version) probed with the TypeScript compiler API: dependency and
// consumer both ship raw TS, so compiling the consumer's import statements
// verbatim against the floor source is exact — `export *` chains, aliases,
// `.js`-to-`.ts` specifiers, and type-only imports all come along. Only the
// missing-member and unresolvable-module diagnostics are failure codes;
// everything else in the floor's own source is noise we must not judge.
//
// Known limits, accepted on purpose: namespace member usage is probed in
// value positions via property access only — type-only namespaces, element
// access (`kit["x"]`), and `require()` are not collected; dynamic `import()`
// is resolution-checked only. The probe is exact for one dependency level:
// a floor's own @estebanforge/* imports resolve through the current
// workspace snapshot, not that package's published floor, so transitive
// pairs are checked leniently (workspace code is never older than a
// published floor). External re-export targets (`export * from
// "@earendil-works/pi-tui"`) resolve through the root node_modules because
// the probe dir sits under it. fetchFloor/hasVersion are injected so tests
// run without network.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const FAILURE_CODES = new Set([2305, 2724, 2614, 2459, 2460, 1192, 2307, 2882, 2339]);
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// Only ranges with a single floor are verifiable. Returns x.y.z or null.
export function parseFloor(range) {
  const match = /^[\^~]?(\d+\.\d+\.\d+)$/.exec(range);
  return match ? match[1] : null;
}

const newer = (a, b) => {
  const [x, y, z] = a.split(".").map(Number);
  const [p, q, r] = b.split(".").map(Number);
  return x !== p ? x > p : y !== q ? y > q : z > r;
};

function sourceFilesUnder(pkgDir, files) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_EXTS.some((ext) => entry.name.endsWith(ext))) found.push(full);
    }
  };
  for (const file of files) {
    // Plain names and directories only; globs and negations never appear in
    // this repo's manifests and are skipped silently if someone adds one.
    const full = join(pkgDir, file);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full);
    else if (SOURCE_EXTS.some((ext) => file.endsWith(ext))) found.push(full);
  }
  return found;
}

// Collect @estebanforge import/export statements from every file the
// package ships, verbatim, grouped by dependency. Only shipped files count:
// tests are outside `files` and may import future APIs freely.
function collectWorkspaceImports(pkgDir, pkg) {
  const byDep = new Map(); // dep -> [{ file, text }]
  const undeclared = []; // { file, dep }
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);

  for (const file of sourceFilesUnder(pkgDir, pkg.files ?? [])) {
    const rel = relative(pkgDir, file).replaceAll("\\", "/");
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const imports = []; // @estebanforge import/export declaration nodes
    const dynamic = []; // { text, spec } for import() calls
    const nsMembers = new Map(); // namespace-import local -> Set<member used>
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith("@estebanforge/")
      ) {
        imports.push(node);
        const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) && !clause.isTypeOnly) {
          nsMembers.set(clause.namedBindings.name.text, new Set());
        }
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text.startsWith("@estebanforge/")
      ) {
        dynamic.push({ text: `import(${node.arguments[0].getText(source)});`, spec: node.arguments[0].text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    // Members actually used through each namespace local. Without this a
    // `kit.dialogChoice()` call would pass a floor missing dialogChoice —
    // the exact 1.8.1 failure shape through a namespace import.
    const harvest = (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        nsMembers.get(node.expression.text)?.add(node.name.text);
      }
      ts.forEachChild(node, harvest);
    };
    harvest(source);
    const statements = imports.map((node) => {
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      let text = node.getText(source);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        const members = nsMembers.get(clause.namedBindings.name.text);
        if (members?.size) {
          const local = clause.namedBindings.name.text;
          text += `\n${[...members].map((m) => `void ${local}.${m};`).join("\n")}`;
        }
      }
      return { text, spec: node.moduleSpecifier.text };
    });
    statements.push(...dynamic);
    for (const { text, spec } of statements) {
      const dep = spec.split("/").slice(0, 2).join("/");
      if (!declared.has(dep)) undeclared.push({ file: rel, dep });
      else byDep.set(dep, [...(byDep.get(dep) ?? []), { file: rel, text }]);
    }
  }
  return { byDep, undeclared };
}

// Compile the consumer's statements for one dependency against the
// extracted floor in tmpDir/node_modules and report every missing member or
// unresolvable module, mapped back to the consumer file it came from.
function probeFloor(imports, dep, floor, range, tmpDir) {
  const problems = [];
  const probes = imports.map(({ file, text }, index) => {
    const probe = join(tmpDir, `probe-${index}.ts`);
    writeFileSync(probe, text);
    return { probe, file };
  });
  if (probes.length === 0) return problems;

  const program = ts.createProgram({
    rootNames: probes.map((p) => p.probe),
    options: {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.Latest,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      // Side-effect-only imports get a resolution diagnostic this way;
      // without it `import "@estebanforge/x"` is checked by nothing.
      noUncheckedSideEffectImports: true,
      types: [],
    },
  });
  const probePaths = new Set(probes.map((p) => p.probe));
  const seen = new Set();
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (!diagnostic.file || !probePaths.has(diagnostic.file.fileName)) continue;
    if (!FAILURE_CODES.has(diagnostic.code)) continue;
    const consumer = probes.find((p) => p.probe === diagnostic.file.fileName)?.file ?? "";
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const key = `${consumer}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const remedy =
      diagnostic.code === 2307 || diagnostic.code === 2882
        ? `the floor ${floor} tarball does not resolve it; check the subpath or republish the library`
        : `floor ${floor} (declared "${range}") lacks it; raise the floor`;
    problems.push(`${consumer}: ${message} — ${remedy}`);
  }
  return problems;
}

function defaultWorkspaceVersion(rootDir, dep) {
  const pkgPath = join(rootDir, "packages", dep.replace("@estebanforge/", ""), "package.json");
  if (!existsSync(pkgPath)) return null;
  return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? null;
}

// The gate proper: one problem string per failure, [] when every floor
// covers its imports. Network access is confined to the injected functions.
export async function checkFloors({ rootDir, pkgDir, fetchFloor, hasVersion, workspaceVersion }) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const wsVersion = workspaceVersion ?? ((dep) => defaultWorkspaceVersion(rootDir, dep));
  const problems = [];
  const { byDep, undeclared } = collectWorkspaceImports(pkgDir, pkg);
  for (const { file, dep } of undeclared) {
    problems.push(`${file} imports ${dep} but package.json does not declare it`);
  }

  // Dependencies and peer dependencies are probed strictly; an optional
  // dependency that is absent from npm is legal by definition and only
  // skipped, never failed. First block wins on duplicates.
  const floors = new Map();
  for (const [block, optional] of [
    [pkg.dependencies ?? {}, false],
    [pkg.peerDependencies ?? {}, false],
    [pkg.optionalDependencies ?? {}, true],
  ]) {
    for (const [dep, range] of Object.entries(block)) {
      if (dep.startsWith("@estebanforge/")) floors.set(dep, { range, optional });
    }
  }
  for (const [dep, { range, optional }] of floors) {
    const floor = parseFloor(range);
    if (!floor) {
      problems.push(`dependency ${dep} "${range}" is not ^x.y.z or ~x.y.z; declare a single floor`);
      continue;
    }
    const workspaceCopy = wsVersion(dep);
    if (workspaceCopy && newer(floor, workspaceCopy)) {
      problems.push(`floor ${floor} of ${dep} is above the workspace version ${workspaceCopy}; npm run check would test the wrong code`);
      continue;
    }
    try {
      await hasVersion(dep, floor);
    } catch (error) {
      if (optional && error?.code === "E404") continue;
      problems.push(
        error?.code === "E404"
          ? `${dep}@${floor} is not on npm; publish it first or raise the floor`
          : `cannot reach npm to verify ${dep}@${floor} (${error?.message ?? error}); fix network and re-run`,
      );
      continue;
    }
    const tmpDir = join(rootDir, "node_modules", ".cache", "floor-gate", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const floorDir = join(tmpDir, "node_modules", "@estebanforge", dep.replace("@estebanforge/", ""));
      mkdirSync(floorDir, { recursive: true });
      await fetchFloor(dep, floor, floorDir);
      problems.push(...probeFloor(byDep.get(dep) ?? [], dep, floor, range, tmpDir));
    } catch (error) {
      problems.push(`could not verify ${dep}@${floor}: ${error?.message ?? error}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  return problems;
}

// Production adapters: real registry + tarball. Kept next to the gate so
// the wiring scripts stay thin.
export function hasVersionOnNpm(dep, floor) {
  try {
    execFileSync("npm", ["view", `${dep}@${floor}`, "version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    throw stderr.includes("E404") ? Object.assign(error, { code: "E404" }) : error;
  }
}

export function fetchFloorFromNpm(dep, floor, destDir) {
  // --ignore-scripts: the floor tarball is data to inspect, never execute.
  const packed = execFileSync(
    "npm",
    ["pack", `${dep}@${floor}`, "--ignore-scripts", "--json", "--pack-destination", destDir],
    { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(packed);
  // npm's --json shape is an object keyed by package name (an array in some
  // versions); both carry `filename` on the entry.
  const entry = Array.isArray(parsed) ? parsed[0] : parsed[dep];
  const tarball = entry?.filename;
  if (!tarball) throw new Error(`npm pack returned no filename for ${dep}@${floor}`);
  execFileSync("tar", ["-xzf", join(destDir, tarball), "-C", destDir, "--strip-components=1", "--no-same-owner"], {
    timeout: 60_000,
  });
}
