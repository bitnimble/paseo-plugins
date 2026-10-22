import assert from "node:assert/strict";
import { chmodSync, mkdirSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { listBranches, previewBlob, readDiff } from "../server/git";
import { parseDiff, serializeDiff } from "../shared/diff";
import { DEFAULT_BRANCH_MODE, UNCOMMITTED_MODE } from "../shared/protocol";
import { freshRepo, gitIn, removeScratch, scratchDirectory, writeIn } from "./repo";

let repo = "";

function git(...args: string[]): string {
  return gitIn(repo, ...args);
}

function write(path: string, content: string | Buffer, root = repo): void {
  writeIn(root, path, content);
}

const numbered = (count: number, tag = "line") =>
  Array.from({ length: count }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

before(() => {
  repo = freshRepo();
  write(".gitignore", "ignored.log\n");
  write("a.txt", numbered(20));
  write("b.txt", numbered(5, "bee"));
  write("space name.txt", "first\n");
  write("del.txt", "going away\n");
  write("mode.sh", "echo hi\n");
  write("rename-src.txt", numbered(30, "moving"));
  write("noeol.txt", "no newline");
  write("bin.dat", Buffer.from([0, 1, 2, 3, 0, 255]));
  git("add", "-A");
  git("commit", "-q", "-m", "base");

  git("checkout", "-q", "-b", "feature");
  write("a.txt", numbered(20).replace("line 2\n", "line two\n").replace("line 19\n", "line nineteen\n"));
  unlinkSync(join(repo, "del.txt"));
  git("mv", "rename-src.txt", "renamed.txt");
  write("renamed.txt", numbered(30, "moving").replace("moving 30", "moved 30"));
  chmodSync(join(repo, "mode.sh"), 0o755);
  write("bin.dat", Buffer.from([0, 9, 9, 9, 0, 255]));
  git("add", "-A");
  git("commit", "-q", "-m", "feature work");

  write("b.txt", numbered(5, "bee").replace("bee 3", "BEE 3"));
  write("space name.txt", "first\nsecond\n");
  git("add", "space name.txt");
  mkdirSync(join(repo, "new dir"));
  write("new dir/ünïcode.txt", "hello\n");
  write("noeol.txt", "still no newline");
  write("ignored.log", "noise\n");
});

after(removeScratch);

function paths(raw: string): Map<string, string> {
  return new Map(parseDiff(raw).files.map((file) => [file.path, file.status]));
}

test("branch mode covers commits, staged, unstaged and untracked changes", async () => {
  const { raw, base } = await readDiff(repo, DEFAULT_BRANCH_MODE);
  assert.equal(base.label, "main");
  assert.deepEqual(
    paths(raw),
    new Map([
      ["a.txt", "modified"],
      ["b.txt", "modified"],
      ["bin.dat", "modified"],
      ["del.txt", "deleted"],
      ["mode.sh", "modified"],
      ["new dir/ünïcode.txt", "added"],
      ["noeol.txt", "modified"],
      ["renamed.txt", "renamed"],
      ["space name.txt", "modified"],
    ]),
  );
});

test("uncommitted mode covers only the working tree against HEAD", async () => {
  const { raw, base } = await readDiff(repo, UNCOMMITTED_MODE);
  assert.equal(base.label, "HEAD");
  assert.deepEqual(
    [...paths(raw).keys()],
    ["b.txt", "new dir/ünïcode.txt", "noeol.txt", "space name.txt"],
  );
});

test("a named branch diffs against its merge-base and refuses refs that do not exist", async () => {
  git("branch", "-q", "midway", "HEAD~1");
  try {
    const { raw, base } = await readDiff(repo, { kind: "branch", branch: "midway" });
    assert.deepEqual(base, { label: "midway", sha: git("rev-parse", "HEAD~1").trim() });
    assert.deepEqual(
      [...paths(raw).keys()],
      ["a.txt", "b.txt", "bin.dat", "del.txt", "mode.sh", "new dir/ünïcode.txt", "noeol.txt", "renamed.txt", "space name.txt"],
    );
    await assert.rejects(readDiff(repo, { kind: "branch", branch: "nope" }), /No branch named nope/);
    await assert.rejects(readDiff(repo, { kind: "branch", branch: "--output=/tmp/x" }), /No branch named/);
  } finally {
    git("branch", "-q", "-D", "midway");
  }
});

test("branches list the default branch and every other, newest first", async () => {
  process.env.GIT_COMMITTER_DATE = "2090-01-01T00:00:00+0000";
  try {
    git("branch", "zz-newest", git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "later").trim());
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
  }
  git("update-ref", "refs/remotes/origin/main", "main");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  try {
    assert.deepEqual(await listBranches(repo), {
      defaultBranch: "main",
      branches: ["zz-newest", "feature", "main", "origin/main"],
    });
  } finally {
    git("branch", "-D", "zz-newest");
    git("update-ref", "-d", "refs/remotes/origin/HEAD");
    git("update-ref", "-d", "refs/remotes/origin/main");
  }
});

test("linguist-generated marks files generated, and unsetting it overrides the name", async () => {
  const dir = freshRepo();
  write(".gitattributes", "db/* linguist-generated=true\nyarn.lock -linguist-generated\n", dir);
  mkdirSync(join(dir, "db"));
  write("db/schema.ts", "export {};\n", dir);
  write("yarn.lock", "a\n", dir);
  write("pnpm-lock.yaml", "b\n", dir);
  write("app.ts", "c\n", dir);
  const { raw, facts } = await readDiff(dir, DEFAULT_BRANCH_MODE);
  assert.deepEqual(facts.generated, { "db/schema.ts": true, "yarn.lock": false });
  assert.deepEqual(
    parseDiff(raw, facts).files.map((file) => [file.path, file.generated]),
    [
      [".gitattributes", false],
      ["app.ts", false],
      ["db/schema.ts", true],
      ["pnpm-lock.yaml", true],
      ["yarn.lock", false],
    ],
  );
});

test("binary sides preview as images, hidden text or plain binary", async () => {
  const dir = freshRepo();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  write(".gitattributes", "generated.ts -diff\n", dir);
  write("logo.png", png, dir);
  write("generated.ts", "export const x = 1;\n", dir);
  write("blob.dat", Buffer.from([1, 0, 2]), dir);
  const { raw, tree, facts } = await readDiff(dir, DEFAULT_BRANCH_MODE);
  const files = new Map(parseDiff(raw, facts).files.map((file) => [file.path, file]));
  assert.deepEqual(
    ["logo.png", "generated.ts", "blob.dat", ".gitattributes"].map((path) => {
      const file = files.get(path);
      return [file?.binary, file?.sizeChange];
    }),
    [
      [true, 12],
      [true, 20],
      [true, 3],
      [false, null],
    ],
  );
  write("blob.dat", Buffer.from([1, 0]), dir);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "base");
  write("blob.dat", Buffer.from([1, 0, 2, 3, 4]), dir);
  assert.deepEqual((await readDiff(dir, UNCOMMITTED_MODE)).facts.sizes, { "blob.dat": { before: 2, after: 5 } });
  write("blob.dat", Buffer.from([1, 0, 2]), dir);

  assert.deepEqual(await previewBlob(dir, tree, "logo.png", null), {
    status: "image",
    uri: `data:image/png;base64,${png.toString("base64")}`,
    bytes: png.length,
  });
  assert.deepEqual(await previewBlob(dir, tree, "generated.ts", null), { status: "text" });
  assert.deepEqual(await previewBlob(dir, tree, "blob.dat", null), { status: "binary" });

  const gone = "0".repeat(40);
  const blob = files.get("logo.png")?.newBlob ?? null;
  assert.equal((await previewBlob(dir, gone, "logo.png", blob)).status, "image");
  await assert.rejects(previewBlob(dir, gone, "logo.png", null));
  await assert.rejects(previewBlob(dir, tree, "logo.png", "--output=x"), /Not an object id/);
});

test("LFS files diff as pointers and preview the content they name", async (t) => {
  const dir = freshRepo();
  try {
    gitIn(dir, "lfs", "install", "--local");
  } catch {
    t.skip("git-lfs is not installed");
    return;
  }
  const png = (...tail: number[]) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]);
  const [old, next] = [png(1), png(2, 3, 4)];
  write("notes.txt", "plain\n", dir);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "before lfs");
  write(".gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n*.txt filter=lfs diff=lfs merge=lfs -text\n", dir);
  write("logo.png", old, dir);
  // Not -A: within the same second git re-reads notes.txt and would store it as a pointer already.
  gitIn(dir, "add", ".gitattributes", "logo.png");
  gitIn(dir, "commit", "-q", "-m", "base");
  write("logo.png", next, dir);
  write("notes.txt", "plain\nmore\n", dir);
  const oid = "a".repeat(64);
  write("huge.png", `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 99999999\n`, dir);

  const { raw, tree, base, facts } = await readDiff(dir, UNCOMMITTED_MODE);
  const files = new Map(parseDiff(raw, facts).files.map((file) => [file.path, file]));
  assert.deepEqual(
    ["logo.png", "huge.png", "notes.txt"].map((path) => {
      const file = files.get(path);
      return [file?.binary, file?.lfs, file?.sizeChange];
    }),
    [
      [false, true, 2],
      [false, true, 99999999],
      [false, false, null],
    ],
  );
  const image = (bytes: Buffer) => ({ status: "image", uri: `data:image/png;base64,${bytes.toString("base64")}`, bytes: bytes.length });
  assert.deepEqual(await previewBlob(dir, base.sha, "logo.png", null, true), image(old));
  assert.deepEqual(await previewBlob(dir, tree, "logo.png", null, true), image(next));
  assert.deepEqual(await previewBlob(dir, tree, "huge.png", null, true), { status: "binary" });
});

test("parsing is lossless and reads file metadata", async () => {
  const { raw } = await readDiff(repo, DEFAULT_BRANCH_MODE);
  const diff = parseDiff(raw);
  assert.equal(serializeDiff(diff), raw);

  const byPath = new Map(diff.files.map((file) => [file.path, file]));
  assert.equal(byPath.get("bin.dat")?.binary, true);
  assert.equal(byPath.get("renamed.txt")?.oldPath, "rename-src.txt");
  assert.equal(byPath.get("mode.sh")?.hunks.length, 0);
  assert.equal(byPath.get("a.txt")?.additions, 2);
  assert.equal(byPath.get("a.txt")?.deletions, 2);
  const noeol = byPath.get("noeol.txt")?.hunks[0].lines ?? [];
  assert.deepEqual(
    noeol.map((line) => [line.kind, line.noNewlineMarker != null]),
    [
      ["del", true],
      ["add", true],
    ],
  );
});

test("reading the diff leaves the real index and working tree alone", async () => {
  const status = git("status", "--porcelain=v1", "-uall");
  const staged = git("diff", "--cached", "--name-only");
  await readDiff(repo, DEFAULT_BRANCH_MODE);
  await readDiff(repo, UNCOMMITTED_MODE);
  assert.equal(git("status", "--porcelain=v1", "-uall"), status);
  assert.equal(git("diff", "--cached", "--name-only"), staged);
});

test("a same-size edit in the same second as the index is still in the diff", async () => {
  const dir = freshRepo();
  const file = join(dir, "app.ts");
  const second = 1_700_000_000;
  write("app.ts", "one\ntwo\n", dir);
  utimesSync(file, second, second);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "base");
  write("app.ts", "one\nTWO\n", dir);
  utimesSync(file, second, second);
  utimesSync(join(dir, ".git", "index"), second, second);
  assert.deepEqual([...paths((await readDiff(dir, UNCOMMITTED_MODE)).raw).keys()], ["app.ts"]);
});

test("the hash follows the diff text", async () => {
  const first = await readDiff(repo, UNCOMMITTED_MODE);
  assert.equal((await readDiff(repo, UNCOMMITTED_MODE)).hash, first.hash);
  write("b.txt", numbered(5, "bee"));
  try {
    assert.notEqual((await readDiff(repo, UNCOMMITTED_MODE)).hash, first.hash);
  } finally {
    write("b.txt", numbered(5, "bee").replace("bee 3", "BEE 3"));
  }
});

test("a repository without commits diffs everything against the empty tree", async () => {
  const dir = freshRepo();
  write("first.txt", "hello\n", dir);
  const { raw, base } = await readDiff(dir, DEFAULT_BRANCH_MODE);
  assert.equal(base.label, "empty repository");
  assert.deepEqual(paths(raw), new Map([["first.txt", "added"]]));
});

test("a nested repository without commits does not hide the rest of the diff", async () => {
  const dir = freshRepo();
  write("kept.txt", "one\n", dir);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "base");
  mkdirSync(join(dir, "nested"));
  gitIn(join(dir, "nested"), "init", "-q");
  write("kept.txt", "two\n", dir);
  assert.deepEqual([...paths((await readDiff(dir, UNCOMMITTED_MODE)).raw).keys()], ["kept.txt"]);
});

test("a linked worktree on a detached HEAD diffs against its branch point", async () => {
  const dir = freshRepo();
  write("shared.txt", "base\n", dir);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "base");
  const linked = join(scratchDirectory(), "linked");
  gitIn(dir, "worktree", "add", "-q", "--detach", linked);
  write("shared.txt", "changed\n", linked);
  gitIn(linked, "commit", "-q", "-am", "work");
  write("loose.txt", "untracked\n", linked);
  gitIn(dir, "commit", "-q", "--allow-empty", "-m", "main moves on");

  const { raw, base } = await readDiff(linked, DEFAULT_BRANCH_MODE);
  assert.equal(base.label, "main");
  assert.deepEqual(
    paths(raw),
    new Map([
      ["loose.txt", "added"],
      ["shared.txt", "modified"],
    ]),
  );
  assert.equal(gitIn(linked, "status", "--porcelain=v1"), "?? loose.txt\n");
});
