import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Difftastic, parseSyntaxDiff } from "../server/difftastic";
import { removeScratch, scratchDirectory } from "./repo";

after(removeScratch);

const OLD = `export const answerSchema = z.object({
  label: "café",
});
`;
const NEW = `const extra = 1;

export const answerSchema = z.object({
  label: "café au lait",
});
`;
// difft 0.72.0 --display json on OLD and NEW, trimmed to the lines the tests read.
const OUTPUT = JSON.stringify({
  aligned_lines: [[null, 0], [null, 1], [0, 2], [1, 3], [2, 4], [3, 5]],
  chunks: [
    [
      { rhs: { line_number: 0, changes: [{ start: 0, end: 5, content: "const", highlight: "keyword" }] } },
      {
        lhs: { line_number: 1, changes: [{ start: 10, end: 15, content: "café", highlight: "string" }] },
        rhs: {
          line_number: 3,
          changes: [
            { start: 10, end: 15, content: "café", highlight: "string" },
            { start: 16, end: 18, content: "au", highlight: "string" },
            { start: 19, end: 23, content: "lait", highlight: "string" },
          ],
        },
      },
    ],
  ],
  language: "TypeScript",
  path: "answer_schema.ts",
  status: "changed",
});

test("difftastic's byte columns become character columns keyed by line, joined across whitespace", () => {
  assert.deepEqual(parseSyntaxDiff(OUTPUT, OLD, NEW), {
    language: "TypeScript",
    aligned: [[null, 0], [null, 1], [0, 2], [1, 3], [2, 4], [3, 5]],
    oldChanges: { 1: [{ start: 10, end: 14, highlight: "string" }] },
    newChanges: {
      0: [{ start: 0, end: 5, highlight: "keyword" }],
      3: [{ start: 10, end: 22, highlight: "string" }],
    },
  });
});

test("identical sides come back with nothing aligned or changed", () => {
  const unchanged = JSON.stringify({ language: "TypeScript", path: "a.ts", status: "unchanged" });
  assert.deepEqual(parseSyntaxDiff(unchanged, OLD, OLD), {
    language: "TypeScript",
    aligned: [],
    oldChanges: {},
    newChanges: {},
  });
});

/** A fake `difft` that needs the unstable flag for JSON, like the real one. */
function fakeDifft(dir: string): void {
  writeFileSync(join(dir, "output.json"), OUTPUT);
  const script = join(dir, "difft");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then printf "Difftastic 9.9.9\\n\\nToolchain: x\\n"; exit 0; fi',
      '[ "$DFT_UNSTABLE" = "yes" ] || { echo "set DFT_UNSTABLE" >&2; exit 1; }',
      `exec /bin/cat ${JSON.stringify(join(dir, "output.json"))}`,
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
}

test("a missing difft is reported until a recheck finds it installed", async () => {
  const bin = scratchDirectory();
  const difftastic = new Difftastic({ PATH: bin });

  const missing = await difftastic.status(false);
  assert.equal(missing.status, "missing");
  await assert.rejects(difftastic.diff("a.ts", OLD, NEW), /isn't on the PATH/);

  fakeDifft(bin);
  assert.equal((await difftastic.status(false)).status, "missing");
  assert.deepEqual(await difftastic.status(true), { status: "available", version: "9.9.9" });
  assert.deepEqual((await difftastic.diff("answer_schema.ts", OLD, NEW)).newChanges[3], [
    { start: 10, end: 22, highlight: "string" },
  ]);
});

const installed = (() => {
  try {
    return /^Difftastic /.test(execFileSync("difft", ["--version"], { encoding: "utf8" }));
  } catch {
    return false;
  }
})();

test("the installed difft pairs a moved, re-indented block by syntax", { skip: !installed && "no difft on PATH" }, async () => {
  const original = `export const answerSchema = z.object({
  questionKey: z.string(),
  evidence: z.array(
    z.object({
      hearingId: z.string(),
    }),
  ),
});
`;
  const modified = `const transcriptEvidenceSchema = z.object({
  hearingId: z.string(),
});

export const answerSchema = z.object({
  questionKey: z.string(),
  evidence: z.array(transcriptEvidenceSchema),
});
`;
  const diff = await new Difftastic().diff("schema.ts", original, modified);

  assert.equal(diff.language, "TypeScript");
  assert.ok(diff.aligned.some(([old, now]) => old === 0 && now === 4), "the answerSchema line stays paired");
  assert.ok(diff.aligned.some(([old, now]) => old === 1 && now === 5), "so does questionKey");
  assert.equal(diff.oldChanges[0], undefined);
});
