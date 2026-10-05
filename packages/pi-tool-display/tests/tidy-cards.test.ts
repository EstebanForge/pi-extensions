import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildTidyHeaderLine,
  countDiffChanges,
  countGrepMatches,
  firstNonEmptyLine,
  tidyIcon,
  type TidyTheme,
} from "../lib/tidy-cards";

const theme: TidyTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

test("tidy icons map each built-in tool family and fall back to a diamond", () => {
  assert.equal(tidyIcon("read"), "📖");
  assert.equal(tidyIcon("grep"), "📖");
  assert.equal(tidyIcon("find"), "📖");
  assert.equal(tidyIcon("ls"), "📖");
  assert.equal(tidyIcon("edit"), "✏️");
  assert.equal(tidyIcon("write"), "✏️");
  assert.equal(tidyIcon("bash"), "⚡");
  assert.equal(tidyIcon("unknown_tool"), "◆");
});

test("tidy header lines show icon, tool name, and argument detail", () => {
  assert.equal(buildTidyHeaderLine("read", { path: "src/auth.ts" }, theme), "📖 read src/auth.ts");
  assert.equal(
    buildTidyHeaderLine("read", { path: "src/auth.ts", offset: 10, limit: 5 }, theme),
    "📖 read src/auth.ts:10-14",
  );
  assert.equal(
    buildTidyHeaderLine("grep", { pattern: "verifyToken", path: "src" }, theme),
    "📖 grep /verifyToken/ in src",
  );
  assert.equal(
    buildTidyHeaderLine("grep", { pattern: "x", path: "src", glob: "*.ts", limit: 5 }, theme),
    "📖 grep /x/ in src (*.ts) limit 5",
  );
  assert.equal(
    buildTidyHeaderLine("find", { pattern: "*.spec.ts", path: "src", limit: 5 }, theme),
    "📖 find *.spec.ts in src limit 5",
  );
  assert.equal(buildTidyHeaderLine("ls", { path: "src" }, theme), "📖 ls src");
});

test("tidy headers degrade gracefully when arguments are missing", () => {
  assert.equal(buildTidyHeaderLine("read", {}, theme), "📖 read ...");
  assert.equal(buildTidyHeaderLine("unknown_tool", { anything: 1 }, theme), "◆ unknown_tool");
});

test("tidy headers survive nullish arguments without throwing", () => {
  assert.equal(buildTidyHeaderLine("read", undefined as never, theme), "📖 read ...");
  assert.equal(buildTidyHeaderLine("grep", null as never, theme), "📖 grep /.../ in .");
});

test("firstNonEmptyLine skips blank leading lines", () => {
  assert.equal(firstNonEmptyLine("\n\nboom\nrest"), "boom");
  assert.equal(firstNonEmptyLine(""), "");
});

test("grep match counting counts lines and unique source files", () => {
  assert.deepEqual(
    countGrepMatches(["src/a.ts:1:alpha", "src/b.ts:2:beta", "src/a.ts:3:gamma", ""]),
    { matches: 3, files: 2 },
  );
});

test("grep match counting falls back to zero files for non file:line output", () => {
  assert.deepEqual(countGrepMatches(["plain text output"]), { matches: 1, files: 0 });
  assert.deepEqual(countGrepMatches([]), { matches: 0, files: 0 });
});

test("grep file counting ignores colons and digits inside the matched text", () => {
  assert.deepEqual(
    countGrepMatches([
      "src/server.ts:10: listen: 8080: ready",
      "src/server.ts:25: retry at 12:34:05 UTC",
      "src/other.ts:1: alpha",
    ]),
    { matches: 3, files: 2 },
  );
});

test("diff change counting tallies added and removed lines", () => {
  assert.deepEqual(countDiffChanges("+added\n-removed\n context\n+++header\n---header\n"), {
    added: 1,
    removed: 1,
  });
  assert.deepEqual(countDiffChanges(""), { added: 0, removed: 0 });
});
