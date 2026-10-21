import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readDiff } from "../server/git";
import { UNCOMMITTED_MODE } from "../shared/protocol";
import { LanguageServers } from "../server/lsp/pool";
import { TreeFiles } from "../server/trees";
import { freshRepo, gitIn, removeScratch, scratchDirectory, writeIn } from "./repo";

const hasServer = (() => {
  try {
    execFileSync("sh", ["-c", "command -v typescript-language-server"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let repo = "";
const servers = new LanguageServers(new TreeFiles());

before(() => {
  repo = freshRepo();
  writeIn(repo, "lib.ts", "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  writeIn(repo, "use.ts", 'import { greet } from "./lib";\n\nexport const message = greet("review");\n');
});

after(async () => {
  await servers.dispose();
  removeScratch();
});

test("definition at a call site in the diff resolves to the declaration", { skip: !hasServer }, async () => {
  const snapshot = await readDiff(repo, UNCOMMITTED_MODE);
  const outcome = await servers.request({
    root: snapshot.root,
    tree: snapshot.tree,
    path: "use.ts",
    method: "textDocument/definition",
    params: { position: { line: 2, character: 24 } },
  });
  assert.equal(outcome.status, "ok");
  const [location] = (outcome.status === "ok" ? outcome.result : []) as { uri?: string; targetUri?: string }[];
  assert.equal(location?.targetUri ?? location?.uri, `file://${join(snapshot.root, "lib.ts")}`);
  assert.match(await servers.readFile(snapshot.root, join(snapshot.root, "lib.ts")), /export function greet/);
  const outside = join(scratchDirectory(), "elsewhere.ts");
  writeFileSync(outside, "export {};\n");
  await assert.rejects(servers.readFile(snapshot.root, outside), /No language server reported/);
});

test("a symlink out of the repository is not readable", async () => {
  const outside = join(scratchDirectory(), "secret.ts");
  writeFileSync(outside, "export const secret = 1;\n");
  symlinkSync(outside, join(repo, "escape.ts"));
  await assert.rejects(servers.readFile(repo, "escape.ts"), /resolves outside the repository/);
});

test("files without a language server are unsupported", async () => {
  const outcome = await servers.request({
    root: repo,
    tree: null,
    path: "notes.txt",
    method: "textDocument/hover",
    params: { position: { line: 0, character: 0 } },
  });
  assert.deepEqual(outcome, { status: "unsupported" });
});
