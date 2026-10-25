import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readDiff } from "../server/git";
import { UNCOMMITTED_MODE } from "../shared/protocol";
import { decodeMessages, encodeMessage } from "../server/lsp/framing";
import { LanguageServers } from "../server/lsp/pool";
import { LspSession } from "../server/lsp/session";
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

const ECHO_SERVER = `
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (message.id == null) continue;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.params ?? {} }));
    const out = Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]);
    for (let i = 0; i < out.length; i += 1000) process.stdout.write(out.subarray(i, i + 1000));
  }
});
`;

test("messages decode once whole, however the bytes are split", () => {
  const first = encodeMessage({ id: 1, text: "é".repeat(5) });
  const second = encodeMessage({ id: 2 });
  const both = Buffer.concat([first, second]);
  assert.deepEqual(decodeMessages(both).bodies.map((body) => JSON.parse(body).id), [1, 2]);

  const headerEnd = first.indexOf("\r\n\r\n") + 4;
  assert.deepEqual(decodeMessages(first.subarray(0, 10)), { bodies: [], rest: first.subarray(0, 10), needed: 0 });
  const partial = decodeMessages(first.subarray(0, headerEnd + 3));
  assert.deepEqual([partial.bodies, partial.needed], [[], first.byteLength]);

  const midCharacter = headerEnd + 15;
  const rest = decodeMessages(first.subarray(0, midCharacter)).rest;
  const whole = decodeMessages(Buffer.concat([rest, first.subarray(midCharacter)]));
  assert.deepEqual(JSON.parse(whole.bodies[0]), { id: 1, text: "ééééé" });
  assert.deepEqual([whole.rest.byteLength, whole.needed], [0, 0]);
});

test("a response spread over many chunks arrives whole", async () => {
  const session = await LspSession.start([process.execPath, "-e", ECHO_SERVER], repo);
  try {
    const big = "é".repeat(500_000);
    const [first, second] = await Promise.all([session.request("echo", [big]), session.request("echo", ["small"])]);
    assert.deepEqual(first, [big]);
    assert.deepEqual(second, ["small"]);
  } finally {
    await session.dispose();
  }
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
