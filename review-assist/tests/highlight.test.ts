import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readDiff } from "../server/git";
import { highlightSides } from "../server/highlight";
import { TreeFiles } from "../server/trees";
import { HIGHLIGHT_STYLES, UNCOMMITTED_MODE } from "../shared/protocol";
import { freshRepo, gitIn, removeScratch, writeIn } from "./repo";

after(removeScratch);

test("both sides are highlighted whole, as token lengths covering every line", async () => {
  const repo = freshRepo();
  const before = 'const greeting = "hi";\n/* a\n   comment */\nexport {};\n';
  const afterwards = 'const greeting = "hello";\n/* a\n   comment */\nexport { greeting };\n';
  writeIn(repo, "app.ts", before);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  writeIn(repo, "app.ts", afterwards);
  const snapshot = await readDiff(repo, UNCOMMITTED_MODE);

  const outcome = await highlightSides(new TreeFiles(), {
    root: snapshot.root,
    tree: snapshot.tree,
    base: snapshot.base.sha,
    path: "app.ts",
    oldPath: "app.ts",
  });
  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") return;
  const lengths = (tokens: number[][]) => tokens.map((line) => line.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0));
  const lineLengths = (text: string) => text.split("\n").map((line) => line.length);
  assert.deepEqual(lengths(outcome.old), lineLengths(before));
  assert.deepEqual(lengths(outcome.new), lineLengths(afterwards));
  const styleOf = (tokens: number[][], line: number) =>
    tokens[line].filter((_, i) => i % 2 === 1).map((style) => HIGHLIGHT_STYLES[style] ?? null);
  assert.deepEqual(styleOf(outcome.new, 2), ["comment"]);

  const unsupported = await highlightSides(new TreeFiles(), { ...snapshot, base: snapshot.base.sha, path: "notes.unknownext", oldPath: null });
  assert.deepEqual(unsupported, { status: "unsupported" });
});
