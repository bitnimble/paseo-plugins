import assert from "node:assert/strict";
import { test } from "node:test";
import { type TreeRow, treeOrder, treeRows } from "../shared/tree";

const PATHS = ["src/ui/button.tsx", "README.md", "src/ui/menu.tsx", "src/api/deep/only/route.ts", "src/index.ts"];
const describe = (rows: TreeRow<string>[]) =>
  rows.map((row) => `${"  ".repeat(row.depth)}${row.kind === "directory" ? `${row.name}/${row.collapsed ? " +" : ""}` : row.name}`);

test("files nest under their directories, single-directory chains share a row", () => {
  assert.deepEqual(describe(treeRows(PATHS, (path) => path, new Set())), [
    "src/",
    "  api/deep/only/",
    "    route.ts",
    "  ui/",
    "    button.tsx",
    "    menu.tsx",
    "  index.ts",
    "README.md",
  ]);
});

test("tree order lists the files as the tree shows them", () => {
  assert.deepEqual(treeOrder(PATHS, (path) => path), [
    "src/api/deep/only/route.ts",
    "src/ui/button.tsx",
    "src/ui/menu.tsx",
    "src/index.ts",
    "README.md",
  ]);
});

test("a collapsed directory hides everything under it", () => {
  assert.deepEqual(describe(treeRows(PATHS, (path) => path, new Set(["src/ui", "src/api/deep/only"]))), [
    "src/",
    "  api/deep/only/ +",
    "  ui/ +",
    "  index.ts",
    "README.md",
  ]);
});
