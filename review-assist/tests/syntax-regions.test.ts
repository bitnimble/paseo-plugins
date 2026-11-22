import assert from "node:assert/strict";
import { test } from "node:test";
import type { MonacoRange } from "../client/monaco/api";
import { syntaxRegions } from "../client/monaco/syntax-regions";
import type { SyntaxDiff } from "../shared/protocol";

const range = (line: number, start: number, end = start): MonacoRange => ({
  startLineNumber: line,
  startColumn: start,
  endLineNumber: line,
  endColumn: end,
});

test("git's run holds difftastic's tokens, each anchored on the line pair Monaco aligns", () => {
  // 0 a | 1 drop() | 2 keep(1) | 3 z   against   0 a | 1 add() | 2 keep(2) | 3 z
  const syntax: SyntaxDiff = {
    language: "TypeScript",
    aligned: [[0, 0], [1, null], [null, 1], [2, 2], [3, 3]],
    oldChanges: { 1: [{ start: 0, end: 6, highlight: "normal" }], 2: [{ start: 5, end: 6, highlight: "string" }] },
    newChanges: { 1: [{ start: 0, end: 5, highlight: "normal" }], 2: [{ start: 5, end: 6, highlight: "string" }] },
  };
  const regions = syntaxRegions(
    [{ original: [1, 3], modified: [1, 3] }],
    syntax,
    ["a", "drop()", "keep(1)", "z"],
    ["a", "add()", "keep(2)", "z"],
  );
  assert.deepEqual(regions, [
    {
      original: [2, 4],
      modified: [2, 4],
      inner: [
        { original: range(2, 1), modified: range(2, 1) },
        { original: range(2, 1, 7), modified: range(2, 1) },
        { original: range(2, 1), modified: range(2, 1, 6) },
        { original: range(3, 1), modified: range(3, 1) },
        { original: range(3, 6, 7), modified: range(3, 1) },
        { original: range(3, 1), modified: range(3, 6, 7) },
      ],
    },
  ]);
});

test("an empty paired line, which Monaco can't align inside a region, starts a region of its own", () => {
  const syntax: SyntaxDiff = {
    language: "TypeScript",
    aligned: [[0, 0], [1, 1], [2, null]],
    oldChanges: { 2: [{ start: 0, end: 1, highlight: "normal" }] },
    newChanges: {},
  };
  assert.deepEqual(syntaxRegions([{ original: [0, 3], modified: [0, 2] }], syntax, ["x", "", "y"], ["x", "  "]), [
    { original: [1, 2], modified: [1, 2], inner: [{ original: range(1, 1), modified: range(1, 1) }] },
    {
      original: [2, 4],
      modified: [2, 3],
      inner: [
        { original: range(2, 1), modified: range(2, 1) },
        { original: range(3, 1, 2), modified: range(2, 1) },
      ],
    },
  ]);
});

test("a pair Monaco already aligned past on one side starts a region of its own", () => {
  // The removed `foo` aligns the new side's first line first, so `bar` can't align there inside the region.
  const syntax: SyntaxDiff = {
    language: "TypeScript",
    aligned: [[0, null], [1, null], [2, 0]],
    oldChanges: { 1: [{ start: 0, end: 2, highlight: "normal" }], 2: [{ start: 4, end: 5, highlight: "number" }] },
    newChanges: { 0: [{ start: 4, end: 5, highlight: "number" }] },
  };
  assert.deepEqual(syntaxRegions([{ original: [0, 3], modified: [0, 1] }], syntax, ["", "foo", "bar(1)"], ["bar(2)"]), [
    { original: [1, 3], modified: [1, 1], inner: [] },
    {
      original: [3, 4],
      modified: [1, 2],
      inner: [
        { original: range(3, 1), modified: range(1, 1) },
        { original: range(3, 5, 6), modified: range(1, 1) },
        { original: range(3, 1), modified: range(1, 5, 6) },
      ],
    },
  ]);
});

test("a run on one side only has no inner changes", () => {
  const syntax: SyntaxDiff = {
    language: "TypeScript",
    aligned: [[0, 1]],
    oldChanges: { 0: [{ start: 0, end: 1, highlight: "normal" }] },
    newChanges: {},
  };
  assert.deepEqual(syntaxRegions([{ original: [0, 1], modified: [0, 0] }], syntax, ["x"], []), [
    { original: [1, 2], modified: [1, 1], inner: [] },
  ]);
});

test("a whole removed line anchored on an empty line aligns as Monaco stretches it, over its line break", () => {
  // Monaco stretches `foo();`, anchored on empty new line 2, to lines 3-4 against 2-3, aligning `bar();` beside
  // `b(2)`, so `b(1)` needs a region of its own to sit there.
  const syntax: SyntaxDiff = {
    language: "TypeScript",
    aligned: [[0, 0], [1, 1], [2, null], [3, null], [4, 2], [5, 3]],
    oldChanges: {
      2: [{ start: 0, end: 6, highlight: "normal" }],
      3: [{ start: 0, end: 6, highlight: "normal" }],
      4: [{ start: 2, end: 3, highlight: "number" }],
    },
    newChanges: { 2: [{ start: 2, end: 3, highlight: "number" }] },
  };
  const original = ["a()", "", "foo();", "bar();", "b(1)", "z"];
  const modified = ["a()", "", "b(2)", "z"];
  assert.deepEqual(syntaxRegions([{ original: [1, 5], modified: [1, 3] }], syntax, original, modified), [
    {
      original: [2, 5],
      modified: [2, 3],
      inner: [
        { original: range(2, 1), modified: range(2, 1) },
        {
          original: { startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 1 },
          modified: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 },
        },
        { original: range(4, 1, 7), modified: range(3, 1) },
      ],
    },
    {
      original: [5, 6],
      modified: [3, 4],
      inner: [
        { original: range(5, 1), modified: range(3, 1) },
        { original: range(5, 3, 4), modified: range(3, 1) },
        { original: range(5, 1), modified: range(3, 3, 4) },
      ],
    },
  ]);
});
