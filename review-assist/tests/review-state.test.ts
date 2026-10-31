import assert from "node:assert/strict";
import test from "node:test";
import type { DraftComment } from "../shared/protocol";
import { EMPTY_REVIEW_STATE, applyStateChange } from "../shared/review-state";

function comment(id: string, body: string): DraftComment {
  return {
    id,
    filePath: "app.ts",
    side: "new",
    startLine: 1,
    lineNumber: 1,
    body,
    context: {
      hunkHeader: "@@ -1 +1 @@",
      targetLine: { oldLineNumber: null, newLineNumber: 1, type: "add", content: "one" },
      lines: [],
    },
    suggestion: null,
    createdAt: "2026-10-21T00:00:00.000Z",
  };
}

test("a viewed mark is added once, moves to the end when marked again, and goes when unmarked", () => {
  let state = EMPTY_REVIEW_STATE;
  const view = (path: string, viewed: boolean) => {
    state = applyStateChange(state, { kind: "viewed", marks: [{ path, fingerprint: "1" }], viewed });
  };
  view("a", true);
  view("b", true);
  view("c", true);
  view("a", true);
  view("b", false);
  assert.deepEqual(state, {
    viewed: [
      { path: "c", fingerprint: "1" },
      { path: "a", fingerprint: "1" },
    ],
    comments: [],
  });
});

test("marking several at once adds each once, and unmarking several removes each", () => {
  const start = { viewed: [{ path: "a", fingerprint: "1" }, { path: "b", fingerprint: "1" }], comments: [] };
  const marked = applyStateChange(start, {
    kind: "viewed",
    marks: [
      { path: "a", fingerprint: "1" },
      { path: "c", fingerprint: "1" },
      { path: "c", fingerprint: "1" },
      { path: "c", fingerprint: "2" },
    ],
    viewed: true,
  });
  assert.deepEqual(marked.viewed, [
    { path: "b", fingerprint: "1" },
    { path: "a", fingerprint: "1" },
    { path: "c", fingerprint: "1" },
    { path: "c", fingerprint: "2" },
  ]);
  const unmarked = applyStateChange(marked, {
    kind: "viewed",
    marks: [
      { path: "a", fingerprint: "1" },
      { path: "c", fingerprint: "1" },
      { path: "missing", fingerprint: "1" },
    ],
    viewed: false,
  });
  assert.deepEqual(unmarked.viewed, [
    { path: "b", fingerprint: "1" },
    { path: "c", fingerprint: "2" },
  ]);
});

test("viewed marks keep only the 2000 most recent", () => {
  const full = {
    viewed: Array.from({ length: 2_000 }, (_, i) => ({ path: `f${i}`, fingerprint: "x" })),
    comments: [],
  };
  const { viewed } = applyStateChange(full, { kind: "viewed", marks: [{ path: "new", fingerprint: "x" }], viewed: true });
  assert.equal(viewed.length, 2_000);
  assert.deepEqual(viewed[0], { path: "f1", fingerprint: "x" });
  assert.deepEqual(viewed.at(-1), { path: "new", fingerprint: "x" });
});

test("a batch past the cap keeps the 2000 most recent, in batch order", () => {
  const full = {
    viewed: Array.from({ length: 2_000 }, (_, i) => ({ path: `f${i}`, fingerprint: "x" })),
    comments: [],
  };
  const { viewed } = applyStateChange(full, {
    kind: "viewed",
    marks: [
      { path: "n0", fingerprint: "x" },
      { path: "n1", fingerprint: "x" },
      { path: "n2", fingerprint: "x" },
    ],
    viewed: true,
  });
  assert.equal(viewed.length, 2_000);
  assert.deepEqual(viewed[0], { path: "f3", fingerprint: "x" });
  assert.deepEqual(viewed.slice(-3), [
    { path: "n0", fingerprint: "x" },
    { path: "n1", fingerprint: "x" },
    { path: "n2", fingerprint: "x" },
  ]);
});

test("a batch larger than the cap keeps only its own last 2000", () => {
  const full = {
    viewed: Array.from({ length: 2_000 }, (_, i) => ({ path: `f${i}`, fingerprint: "x" })),
    comments: [],
  };
  const marks = Array.from({ length: 2_500 }, (_, i) => ({ path: `b${i}`, fingerprint: "x" }));
  const { viewed } = applyStateChange(full, { kind: "viewed", marks, viewed: true });
  assert.equal(viewed.length, 2_000);
  assert.deepEqual(viewed, marks.slice(-2_000));
});

test("re-marking a file already at the cap evicts nothing", () => {
  const full = {
    viewed: Array.from({ length: 2_000 }, (_, i) => ({ path: `f${i}`, fingerprint: "x" })),
    comments: [],
  };
  const { viewed } = applyStateChange(full, { kind: "viewed", marks: [{ path: "f0", fingerprint: "x" }], viewed: true });
  assert.equal(viewed.length, 2_000);
  assert.deepEqual(viewed[0], { path: "f1", fingerprint: "x" });
  assert.deepEqual(viewed.at(-1), { path: "f0", fingerprint: "x" });
});

test("an empty batch leaves viewed and comments untouched", () => {
  const start = { viewed: [{ path: "a", fingerprint: "1" }], comments: [comment("1", "one")] };
  assert.deepEqual(applyStateChange(start, { kind: "viewed", marks: [], viewed: true }), start);
  assert.deepEqual(applyStateChange(start, { kind: "viewed", marks: [], viewed: false }), start);
});

test("a comment change drops the removed ids, then saves each comment in place or at the end", () => {
  const state = { viewed: [], comments: [comment("1", "one"), comment("2", "two"), comment("3", "three")] };
  const next = applyStateChange(state, {
    kind: "comments",
    remove: ["2", "4"],
    save: [comment("4", "four"), comment("1", "uno"), comment("2", "dos")],
  });
  assert.deepEqual(
    next.comments.map(({ id, body }) => [id, body]),
    [
      ["1", "uno"],
      ["3", "three"],
      ["4", "four"],
      ["2", "dos"],
    ],
  );
  assert.deepEqual(state.comments.map(({ body }) => body), ["one", "two", "three"]);
});
