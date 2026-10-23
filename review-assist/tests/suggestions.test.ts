import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { commentTarget, suggestible } from "../shared/comments";
import { parseDiff } from "../shared/diff";
import { fullBlocks } from "../shared/guide";
import type { DraftComment } from "../shared/protocol";
import { blockSides } from "../shared/sides";
import { applyEdits, applySuggestions } from "../server/suggestions";
import { removeScratch, scratchDirectory, writeIn } from "./repo";

after(removeScratch);

function comment(startLine: number, lineNumber: number, suggestion: DraftComment["suggestion"], filePath = "f.ts"): DraftComment {
  return {
    id: `${filePath}:${startLine}`,
    filePath,
    side: "new",
    startLine,
    lineNumber,
    body: "",
    context: { hunkHeader: "", targetLine: { oldLineNumber: null, newLineNumber: lineNumber, type: "add", content: "" }, lines: [] },
    suggestion,
    createdAt: "2026-10-23T00:00:00.000Z",
  };
}

test("suggestions replace or delete their lines, keeping the file's line endings", () => {
  assert.equal(
    applyEdits("a\nb\nc\nd\n", [
      comment(2, 3, { original: "b\nc", replacement: "B" }),
      comment(4, 4, { original: "d", replacement: "" }),
    ]),
    "a\nB\n",
  );
  assert.equal(applyEdits("a\r\nb\r\n", [comment(1, 1, { original: "a", replacement: "x\ny" })]), "x\r\ny\r\nb\r\n");
});

test("a suggestion on a CRLF file's diff applies, keeping the CRLFs", () => {
  const diff = parseDiff("diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,2 @@\n-a\r\n+A\r\n b\r\n");
  const target = commentTarget(diff.files[0], blockSides(fullBlocks(diff)[0], "A\r\nb\r\n", false).modified.lines, 0, 1);
  assert.ok(target != null);
  const original = suggestible(target);
  assert.equal(original, "A\nb");
  assert.equal(applyEdits("A\r\nb\r\n", [{ ...comment(1, 2, { original: original ?? "", replacement: "x\ny\nz" }) }]), "x\r\ny\r\nz\r\n");
});

test("a suggestion whose lines changed, or that overlaps another, is refused", () => {
  assert.throws(() => applyEdits("a\nb\n", [comment(2, 2, { original: "B", replacement: "c" })]), /f\.ts line 2 changed/);
  assert.throws(() => applyEdits("a\n", [comment(2, 2, { original: "", replacement: "" })]), /f\.ts line 2 changed/);
  assert.equal(applyEdits("a\n\nb\n", [comment(2, 2, { original: "", replacement: "" })]), "a\nb\n");
  assert.throws(
    () =>
      applyEdits("a\nb\nc\n", [
        comment(1, 2, { original: "a\nb", replacement: "x" }),
        comment(2, 3, { original: "b\nc", replacement: "y" }),
      ]),
    /overlap/,
  );
});

test("sending writes every suggestion or none, and moves later comments past the edits", async () => {
  const root = scratchDirectory();
  writeIn(root, "f.ts", "a\nb\nc\nd\n");
  writeIn(root, "g.ts", "x\n");
  const plain = comment(4, 4, null);
  const spanning = comment(1, 4, null);
  const { applied, rest } = await applySuggestions(root, [
    comment(1, 1, { original: "a", replacement: "a1\na2\na3" }),
    plain,
    spanning,
    comment(1, 1, { original: "x", replacement: "y" }, "g.ts"),
  ]);
  assert.equal(applied.length, 2);
  assert.deepEqual(rest, [
    { ...plain, startLine: 6, lineNumber: 6 },
    { ...spanning, startLine: 1, lineNumber: 6 },
  ]);
  assert.equal(readFileSync(join(root, "f.ts"), "utf8"), "a1\na2\na3\nb\nc\nd\n");
  assert.equal(readFileSync(join(root, "g.ts"), "utf8"), "y\n");

  await assert.rejects(
    applySuggestions(root, [
      comment(1, 1, { original: "y", replacement: "z" }, "g.ts"),
      comment(1, 1, { original: "stale", replacement: "q" }),
    ]),
    /changed since/,
  );
  assert.equal(readFileSync(join(root, "g.ts"), "utf8"), "y\n");
  await assert.rejects(applySuggestions(root, [comment(1, 1, { original: "", replacement: "" }, "../escape.ts")]), /outside/);
  writeIn(root, "latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  await assert.rejects(applySuggestions(root, [comment(1, 1, { original: "caf", replacement: "" }, "latin1.txt")]), /UTF-8/);
});
