import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  toCompletions,
  toHoverMarkdown,
  toLocations,
  toLspPosition,
  toMonacoRange,
} from "../client/convert.ts";
import { isInside, resolveInside } from "../server/files.ts";
import { decodeMessages, encodeMessage } from "../server/framing.ts";
import { languageForPath } from "../shared/languages.ts";

test("framing survives split and coalesced chunks", () => {
  const stream = Buffer.concat([
    encodeMessage({ id: 1, result: "first" }),
    encodeMessage({ id: 2, result: "second" }),
  ]);

  const whole = decodeMessages(stream);
  assert.deepEqual(
    whole.bodies.map((body) => JSON.parse(body)),
    [
      { id: 1, result: "first" },
      { id: 2, result: "second" },
    ],
  );
  assert.equal(whole.rest.byteLength, 0);

  const split = decodeMessages(stream.subarray(0, 20));
  assert.deepEqual(split.bodies, []);
  const finished = decodeMessages(Buffer.concat([split.rest, stream.subarray(20)]));
  assert.equal(finished.bodies.length, 2);
});

test("framing measures bytes, not characters", () => {
  const [body] = decodeMessages(encodeMessage({ text: "héllo →" })).bodies;
  assert.deepEqual(JSON.parse(body ?? ""), { text: "héllo →" });
});

test("locations come back from every shape a server may answer with", () => {
  const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } };
  assert.deepEqual(toLocations({ uri: "file:///a.ts", range }), [{ uri: "file:///a.ts", range }]);
  assert.deepEqual(toLocations([{ uri: "file:///a.ts", range }]), [{ uri: "file:///a.ts", range }]);
  assert.deepEqual(toLocations([{ targetUri: "file:///a.ts", targetRange: range, targetSelectionRange: range }]), [
    { uri: "file:///a.ts", range },
  ]);
  assert.deepEqual(toLocations(null), []);
});

test("positions convert between zero-based LSP and one-based Monaco", () => {
  assert.deepEqual(toLspPosition({ lineNumber: 1, column: 1 }), { line: 0, character: 0 });
  assert.deepEqual(toMonacoRange({ start: { line: 0, character: 0 }, end: { line: 2, character: 4 } }), {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 3,
    endColumn: 5,
  });
});

test("hover contents flatten to markdown", () => {
  assert.equal(toHoverMarkdown({ contents: { kind: "markdown", value: "**x**" } })?.markdown, "**x**");
  assert.equal(
    toHoverMarkdown({ contents: [{ language: "ts", value: "const x: number" }, "docs"] })?.markdown,
    "```ts\nconst x: number\n```\n\ndocs",
  );
  assert.equal(toHoverMarkdown({ contents: [] }), null);
});

test("completion kinds map onto the Monaco enum", () => {
  const [method, keyword] = toCompletions([
    { label: "run", kind: 2 },
    { label: "return", kind: 14 },
  ]);
  assert.equal(method?.kind, 0);
  assert.equal(keyword?.kind, 17);
  assert.equal(method?.insertText, "run");
});

test("writes are confined to the workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monaco-plugin-"));
  assert.equal(resolveInside(directory, "src/app.ts"), join(directory, "src/app.ts"));
  assert.throws(() => resolveInside(directory, "../outside.ts"));
  assert.throws(() => resolveInside(directory, "/etc/passwd"));
  assert.throws(() => resolveInside(directory, `${directory}-sibling/file.ts`));
});

test("containment does not confuse a sibling directory for a child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monaco-plugin-"));
  assert.equal(isInside(directory, join(directory, "src/app.ts")), true);
  assert.equal(isInside(directory, directory), true);
  assert.equal(isInside(directory, `${directory}-sibling/app.ts`), false);
  assert.equal(isInside(directory, "/etc/passwd"), false);
});

test("language routing covers the servers we spawn", () => {
  assert.equal(languageForPath("src/app.tsx")?.lspLanguageId, "typescriptreact");
  assert.equal(languageForPath("src/app.tsx")?.monacoLanguage, "typescript");
  assert.equal(languageForPath("README.md"), null);
  assert.equal(languageForPath(".gitignore"), null);
});
