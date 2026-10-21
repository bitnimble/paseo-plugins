import assert from "node:assert/strict";
import test from "node:test";
import { LINE_PREFIX, parseDiff } from "../shared/diff";
import { hideWhitespaceChanges, splitRows } from "../shared/display";

function hunkLines(body: string[]) {
  const oldCount = body.filter((line) => !line.startsWith("+")).length;
  const newCount = body.filter((line) => !line.startsWith("-")).length;
  const raw = `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,${oldCount} +1,${newCount} @@\n${body.join("\n")}\n`;
  return parseDiff(raw).files[0].hunks[0].lines;
}

const show = (lines: ReturnType<typeof hunkLines>) =>
  lines.map((line) => `${LINE_PREFIX[line.kind]}${line.text} ${line.oldNumber ?? "_"}/${line.newNumber ?? "_"}`);

test("re-indented lines become context, real edits stay changes", () => {
  const lines = hunkLines([" if (a) {", "-  call(x);", "-  other();", "+    call(x);", "+    other(y);", " }"]);
  assert.deepEqual(show(hideWhitespaceChanges(lines)), [
    " if (a) { 1/1",
    "     call(x); 2/2",
    "-  other(); 3/_",
    "+    other(y); _/3",
    " } 4/4",
  ]);
});

test("wrapping code in a new block keeps the moved lines as context", () => {
  const lines = hunkLines(["-a();", "-b();", "+if (ok) {", "+  a();", "+  b();", "+}"]);
  assert.deepEqual(show(hideWhitespaceChanges(lines)), [
    "+if (ok) { _/1",
    "   a(); 1/2",
    "   b(); 2/3",
    "+} _/4",
  ]);
});

test("whitespace-free changes are untouched", () => {
  const lines = hunkLines([" keep", "-old", "+new"]);
  assert.deepEqual(hideWhitespaceChanges(lines), lines);
});

test("split rows pair removals with additions and mirror context", () => {
  const rows = splitRows(hunkLines([" a", "-b", "-c", "+B", " d", "+e"]));
  assert.deepEqual(
    rows.map(({ left, right }) => [left?.text ?? null, right?.text ?? null]),
    [
      ["a", "a"],
      ["b", "B"],
      ["c", null],
      ["d", "d"],
      [null, "e"],
    ],
  );
});
