import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { locateDocument } from "../server/document";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "markdown-review-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("a document in a repository is kept under the repository's top level", async () => {
  const repo = join(scratch, "repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  execFileSync("git", ["init", "--quiet", repo]);
  writeFileSync(join(repo, "docs", "plan.md"), "# Plan\n");

  assert.deepEqual(await locateDocument(join(repo, "docs", "plan.md")), { root: repo, path: "docs/plan.md" });
});

test("a document outside a repository is kept under its own directory", async () => {
  const loose = join(scratch, "loose");
  mkdirSync(loose);
  writeFileSync(join(loose, "notes.md"), "Notes\n");

  assert.deepEqual(await locateDocument(join(loose, "notes.md")), { root: loose, path: "notes.md" });
});
