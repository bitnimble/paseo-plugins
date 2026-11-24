import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownDiff } from "../kit/server/markdown";

test("a document read against itself renders every block, its code colored", () => {
  const document = "# Plan\n\nShip it.\n\n```ts\nconst a = 1;\n```\n";
  const outcome = markdownDiff(document, document);
  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") return;
  assert.deepEqual(
    outcome.entries.map(({ change, block }) => [change, block.kind]),
    [
      ["same", "heading"],
      ["same", "text"],
      ["same", "code"],
    ],
  );
  const code = outcome.entries[2].block;
  assert.ok(code.kind === "code" && code.lines[0].tokens != null);
});
