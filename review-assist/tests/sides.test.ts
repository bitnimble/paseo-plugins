import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readBlob, readDiff } from "../server/git";
import { UNCOMMITTED_MODE } from "../shared/protocol";
import { TreeFiles } from "../server/trees";
import { type DiffFile, type DiffLine, parseDiff } from "../shared/diff";
import { type FileBlock, fullBlocks } from "../shared/guide";
import {
  applyHunks,
  blockHunks,
  blockSides,
  changesThrough,
  hunksOf,
  shownChangeCount,
  takeChanges,
  wholeFileLines,
} from "../shared/sides";
import { freshRepo, gitIn, removeScratch, writeIn } from "./repo";

let repo = "";

const numbered = (count: number, tag = "line") =>
  Array.from({ length: count }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

before(() => {
  repo = freshRepo();
  writeIn(repo, "edits.txt", numbered(40));
  writeIn(repo, "top.txt", numbered(10));
  writeIn(repo, "gains-eol.txt", "one\ntwo");
  writeIn(repo, "loses-eol.txt", "one\ntwo\n");
  writeIn(repo, "crlf.txt", "one\r\ntwo\r\nthree\r\n");
  writeIn(repo, "doomed.txt", numbered(3));
  writeIn(repo, "moving.txt", numbered(30, "moving"));
  writeIn(repo, "hollowed.txt", numbered(12));
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");

  writeIn(
    repo,
    "edits.txt",
    numbered(40).replace("line 3\n", "line three\n").replace("line 30\n", "").concat("line 41\n"),
  );
  writeIn(repo, "top.txt", numbered(10).replace("line 1\nline 2\n", ""));
  writeIn(repo, "gains-eol.txt", "one\ntwo\n");
  writeIn(repo, "loses-eol.txt", "one\ntwo");
  writeIn(repo, "crlf.txt", "one\r\nTWO\r\nthree\r\n");
  unlinkSync(join(repo, "doomed.txt"));
  gitIn(repo, "mv", "moving.txt", "moved.txt");
  writeIn(repo, "moved.txt", numbered(30, "moving").replace("moving 15", "moved 15"));
  writeIn(repo, "hollowed.txt", numbered(12).replace("line 5\nline 6\nline 7\n", ""));
  writeIn(repo, "fresh.txt", "brand\nnew\n");
  writeIn(repo, "empty.txt", "");
});

after(removeScratch);

async function texts(file: DiffFile, root: string, tree: string, base: string) {
  const modified = file.newPath == null ? "" : await readBlob(root, tree, file.newPath);
  const original = file.oldPath == null ? "" : gitIn(root, "show", `${base}:${file.oldPath}`);
  return { modified, original };
}

test("a whole file's block is the old file against the new one, and the hunks rebuild the new one", async () => {
  const snapshot = await readDiff(repo, UNCOMMITTED_MODE);
  const diff = parseDiff(snapshot.raw);
  const checked: string[] = [];
  for (const block of fullBlocks(diff)) {
    const { modified, original } = await texts(block.file, snapshot.root, snapshot.tree, snapshot.base.sha);
    const sides = blockSides(block, modified, false);
    assert.equal(sides.original.text, original, block.file.path);
    assert.equal(sides.modified.text, modified, block.file.path);
    assert.equal(applyHunks(original, block.file), modified, block.file.path);
    checked.push(block.file.path);
  }
  assert.deepEqual(checked.sort(), [
    "crlf.txt",
    "doomed.txt",
    "edits.txt",
    "empty.txt",
    "fresh.txt",
    "gains-eol.txt",
    "hollowed.txt",
    "loses-eol.txt",
    "moved.txt",
    "top.txt",
  ]);
});

test("the whole file's lines cut into hunks around changes, growing with revealed ranges", async () => {
  const snapshot = await readDiff(repo, UNCOMMITTED_MODE);
  const block = fullBlocks(parseDiff(snapshot.raw)).find(({ file }) => file.path === "edits.txt");
  assert.ok(block != null);
  const { modified } = await texts(block.file, snapshot.root, snapshot.tree, snapshot.base.sha);
  const { lines } = wholeFileLines(block, modified, false);
  assert.equal(lines.filter((line) => line.kind !== "del").length, 40);
  const headers = (revealed: [number, number][] = []) => hunksOf(lines, 3, revealed).map(({ header }) => header);
  assert.deepEqual(headers(), ["@@ -1,6 +1,6 @@", "@@ -27,7 +27,6 @@", "@@ -38,3 +37,4 @@"]);
  assert.deepEqual(headers([[6, 12]]), ["@@ -1,11 +1,11 @@", "@@ -27,7 +27,6 @@", "@@ -38,3 +37,4 @@"]);
  assert.deepEqual(headers([[0, lines.length]]), ["@@ -1,40 +1,40 @@"]);
});

const SPLIT = parseDiff(
  [
    "diff --git a/f.txt b/f.txt",
    "index 1111111..2222222 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,4 +1,4 @@",
    " a",
    "-b",
    "+B",
    " c",
    "-d",
    "+D",
    "",
  ].join("\n"),
);
const [splitFile] = SPLIT.files;
const [splitHunk] = splitFile.hunks;
const firstHalf = { hunk: splitHunk, start: 0, end: 3 };
const secondHalf = { hunk: splitHunk, start: 3, end: 6 };
const first: FileBlock = { file: splitFile, chunks: [firstHalf], later: [secondHalf] };
const second: FileBlock = { file: splitFile, chunks: [secondHalf], later: [] };
const numbers = (lines: readonly { oldNumber: number | null; newNumber: number | null }[]) =>
  lines.map(({ oldNumber, newNumber }) => [oldNumber, newNumber]);

test("a section's sides hold earlier sections' changes and leave out later ones", () => {
  const one = blockSides(first, "a\nB\nc\nD\n", false);
  assert.equal(one.original.text, "a\nb\nc\nd\n");
  assert.equal(one.modified.text, "a\nB\nc\nd\n");
  assert.deepEqual(numbers(one.modified.lines), [[1, 1], [null, 2], [3, 3], [4, null]]);

  const two = blockSides(second, "a\nB\nc\nD\n", false);
  assert.equal(two.original.text, "a\nB\nc\nd\n");
  assert.equal(two.modified.text, "a\nB\nc\nD\n");
  assert.deepEqual(numbers(two.original.lines), [[1, 1], [null, 2], [3, 3], [4, null]]);
});

test("a section's hunks show only its own changes, numbered as in the real files", () => {
  const shown = (block: FileBlock) =>
    blockHunks(block, false).hunks.map(({ header, lines }) => [header, lines.map((line) => `${line.kind}:${line.text}`)]);
  assert.deepEqual(shown(first), [["@@ -1,4 +1,3 @@", ["context:a", "del:b", "add:B", "context:c", "context:d"]]]);
  assert.deepEqual(shown(second), [["@@ -1,3 +1,4 @@", ["context:a", "context:B", "context:c", "del:d", "add:D"]]]);
});

test("hiding whitespace shows a whitespace-only edit as unchanged on both sides", () => {
  const diff = parseDiff(
    ["diff --git a/w.txt b/w.txt", "--- a/w.txt", "+++ b/w.txt", "@@ -1,2 +1,2 @@", "-  x", "+x", " y", ""].join("\n"),
  );
  const [block] = fullBlocks(diff);
  const sides = blockSides(block, "x\ny\n", true);
  assert.equal(sides.original.text, sides.modified.text);
  assert.deepEqual(blockHunks(block, true).hunks, []);
  assert.notEqual(blockSides(block, "x\ny\n", false).original.text, "x\ny\n");
});

test("a change limit ends both sides before the first change past it", () => {
  const diff = parseDiff(
    ["diff --git a/l.txt b/l.txt", "--- a/l.txt", "+++ b/l.txt", "@@ -1,4 +1,4 @@", "-a", "+A", " b", " c", "-d", "+D", ""].join(
      "\n",
    ),
  );
  const [block] = fullBlocks(diff);
  const cut = blockSides(block, "A\nb\nc\nD\n", false, 2);
  assert.deepEqual([cut.original.text, cut.modified.text, cut.cut], ["a\nb\nc\n", "A\nb\nc\n", true]);
  const whole = blockSides(block, "A\nb\nc\nD\n", false, 4);
  assert.deepEqual([whole.original.text, whole.modified.text, whole.cut], ["a\nb\nc\nd\n", "A\nb\nc\nD\n", false]);
});

test("a change limit inside a rewritten block keeps old and new lines alike", () => {
  const diff = parseDiff(
    ["diff --git a/r.txt b/r.txt", "--- a/r.txt", "+++ b/r.txt", "@@ -1,3 +1,3 @@", "-a", "-b", "-c", "+A", "+B", "+C", ""].join("\n"),
  );
  const [block] = fullBlocks(diff);
  const sides = blockSides(block, "A\nB\nC\n", false, 4);
  assert.deepEqual([sides.original.text, sides.modified.text, sides.cut], ["a\nb\n", "A\nB\n", true]);
  assert.deepEqual(
    takeChanges(block.file.hunks[0].lines, 3).lines.map((line) => `${line.kind}:${line.text}`),
    ["del:a", "del:b", "add:A"],
  );
});

const MULTI_HUNK_TEXT = Array.from({ length: 30 }, (_, i) =>
  [2, 7, 20, 21, 22].includes(i + 1) ? `L${i + 1}\n` : `l${i + 1}\n`,
).join("");
const [multiHunk] = fullBlocks(
  parseDiff(
    [
      "diff --git a/m.txt b/m.txt",
      "--- a/m.txt",
      "+++ b/m.txt",
      "@@ -1,10 +1,10 @@",
      " l1",
      "-l2",
      "+L2",
      " l3",
      " l4",
      " l5",
      " l6",
      "-l7",
      "+L7",
      " l8",
      " l9",
      " l10",
      "@@ -17,9 +17,9 @@ l16",
      " l17",
      " l18",
      " l19",
      "-l20",
      "-l21",
      "-l22",
      "+L20",
      "+L21",
      "+L22",
      " l23",
      " l24",
      " l25",
      "",
    ].join("\n"),
  ),
);
const CUT_HUNKS: [number, boolean, [string, string[]][]][] = [
  [1, true, [["@@ -1,2 +1,1 @@", ["context:l1", "del:l2"]]]],
  [2, true, [["@@ -1,6 +1,6 @@", ["context:l1", "del:l2", "add:L2", "context:l3", "context:l4", "context:l5", "context:l6"]]]],
  [
    4,
    true,
    [
      [
        "@@ -1,10 +1,10 @@",
        ["context:l1", "del:l2", "add:L2", "context:l3", "context:l4", "context:l5", "context:l6", "del:l7", "add:L7", "context:l8", "context:l9", "context:l10"],
      ],
    ],
  ],
  [
    7,
    true,
    [
      [
        "@@ -1,10 +1,10 @@",
        ["context:l1", "del:l2", "add:L2", "context:l3", "context:l4", "context:l5", "context:l6", "del:l7", "add:L7", "context:l8", "context:l9", "context:l10"],
      ],
      ["@@ -17,5 +17,4 @@", ["context:l17", "context:l18", "context:l19", "del:l20", "del:l21", "add:L20"]],
    ],
  ],
];
const shownHunks = (hunks: readonly { header: string; lines: readonly DiffLine[] }[]) =>
  hunks.map(({ header, lines }): [string, string[]] => [header, lines.map((line) => `${line.kind}:${line.text}`)]);

test("a change limit ends a block's hunks where its uncut hunks reach the cut", () => {
  for (const [limit, cut, hunks] of CUT_HUNKS) {
    const shown = blockHunks(multiHunk, false, limit);
    assert.deepEqual([shown.cut, shownHunks(shown.hunks)], [cut, hunks], `limit ${limit}`);
  }
  const uncut = blockHunks(multiHunk, false, 10);
  assert.deepEqual([uncut.cut, uncut.hunks.map(({ header }) => header)], [false, ["@@ -1,10 +1,10 @@", "@@ -17,9 +17,9 @@"]]);
});

test("a change limit ends the whole file's hunks where its uncut hunks reach the cut, as the sides end", () => {
  const whole = wholeFileLines(multiHunk, MULTI_HUNK_TEXT, false).lines;
  for (const [limit, cut, hunks] of CUT_HUNKS) {
    const taken = takeChanges(whole, limit);
    assert.equal(taken.cut, cut, `limit ${limit}`);
    assert.deepEqual(shownHunks(hunksOf(taken.lines, 3, [], taken.cut)), hunks, `limit ${limit}`);
    assert.deepEqual(taken.lines, wholeFileLines(multiHunk, MULTI_HUNK_TEXT, false, limit).lines, `limit ${limit}`);
  }
  const taken = takeChanges(whole, 7);
  assert.deepEqual(
    hunksOf(taken.lines, 3, [[10, 18]], taken.cut).map(({ start, end }) => [start, end]),
    [[0, 24]],
  );
});

test("huge files are rebuilt and shown without overflowing the stack", () => {
  const count = 200_000;
  const old = numbered(count);
  const header = ["diff --git a/big.txt b/big.txt", "--- a/big.txt"];
  const edit = parseDiff([...header, "+++ b/big.txt", `@@ -${count} +${count} @@`, `-line ${count}`, "+last", ""].join("\n"));
  assert.equal(applyHunks(old, edit.files[0]), old.replace(`line ${count}\n`, "last\n"));

  const removed = old.trimEnd().split("\n").map((line) => `-${line}`);
  const removal = parseDiff([...header, "+++ /dev/null", `@@ -1,${count} +0,0 @@`, ...removed, ""].join("\n"));
  assert.equal(blockHunks(fullBlocks(removal)[0], true).hunks[0].lines.length, count);
  assert.equal(wholeFileLines(fullBlocks(removal)[0], "", false).lines.length, count);
});

test("the change limit through a line covers the whole run of changes it sits in", () => {
  const diff = parseDiff(
    [
      "diff --git a/t.txt b/t.txt",
      "--- a/t.txt",
      "+++ b/t.txt",
      "@@ -1,5 +1,5 @@",
      "-a",
      "+A",
      " b",
      "-c",
      "-d",
      "+C",
      "+D",
      " e",
      "",
    ].join("\n"),
  );
  const [block] = fullBlocks(diff);
  const onNew = (number: number) => (line: DiffLine) => line.newNumber === number;
  assert.deepEqual(
    [onNew(1), onNew(2), onNew(3), onNew(5), onNew(9)].map((wanted) => changesThrough(block, false, wanted)),
    [2, 2, 6, 6, 0],
  );
  const sides = blockSides(block, "A\nb\nC\nD\ne\n", false, changesThrough(block, false, onNew(3)));
  assert.equal(sides.modified.text, "A\nb\nC\nD\ne\n");
});

test("a whitespace-only change is not counted among the changes left to show", () => {
  const diff = parseDiff(
    ["diff --git a/w.txt b/w.txt", "--- a/w.txt", "+++ b/w.txt", "@@ -1,2 +1,2 @@", "-  x", "+x", "-y", "+Y", ""].join("\n"),
  );
  const [block] = fullBlocks(diff);
  assert.deepEqual([shownChangeCount(block, false), shownChangeCount(block, true)], [4, 2]);
});

test("the tree holds untracked files exactly as the diff shows them", async () => {
  const snapshot = await readDiff(repo, UNCOMMITTED_MODE);
  assert.equal(await readBlob(snapshot.root, snapshot.tree, "fresh.txt"), "brand\nnew\n");
  await assert.rejects(readBlob(snapshot.root, "HEAD", "fresh.txt"), /Not an object id/);
});

test("a file of a pruned tree is rebuilt from the diff's base", async () => {
  const snapshot = await readDiff(repo, UNCOMMITTED_MODE);
  const pruned = "f".repeat(40);
  const trees = new TreeFiles();
  trees.remember({ ...snapshot, tree: pruned });
  for (const path of ["edits.txt", "moved.txt", "fresh.txt", "loses-eol.txt"]) {
    assert.equal(await trees.read(snapshot.root, pruned, path), await readBlob(snapshot.root, snapshot.tree, path), path);
  }
  await assert.rejects(trees.read(snapshot.root, pruned, "untouched.txt"));
  await assert.rejects(new TreeFiles().read(snapshot.root, pruned, "edits.txt"));
});
