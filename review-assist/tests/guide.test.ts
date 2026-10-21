import assert from "node:assert/strict";
import test from "node:test";
import { isChange, parseDiff, serializeDiff } from "../shared/diff";
import { type DiffChunk, type Proposal, blockFingerprint, buildGuide, composeGuide, guideBlocks } from "../shared/guide";

const RAW = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,8 +1,9 @@
 import a
-import b
+import bee
 const x = 1
 const y = 2
 const z = 3
+const added = 4
 function f() {
   return x
-}
+} // done
@@ -20,3 +21,4 @@ function g() {
 one
+two
 three
 four
diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/package-lock.json b/package-lock.json
index 3333333..4444444 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-{"v":1}
+{"v":2}
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;

const diff = parseDiff(RAW);

function section(
  title: string,
  regions: [hunk: string, from: number, to: number][] = [],
  files: string[] = [],
): Proposal["sections"][number] {
  return { title, description: `${title}.`, regions: regions.map(([hunk, from, to]) => ({ hunk, from, to })), files };
}

function summary(proposal: Proposal) {
  return buildGuide(diff, proposal).map(({ title, regions }) => ({
    title,
    regions: regions.map((region) =>
      region.kind === "file" ? `f${region.fileIndex}` : `${region.hunkId}[${region.start},${region.end})`,
    ),
  }));
}

test("the fixture parses losslessly", () => {
  assert.equal(serializeDiff(diff), RAW);
  assert.deepEqual(
    diff.files.map((file) => [file.path, file.status, file.hunks.map((hunk) => hunk.id)]),
    [
      ["src/app.ts", "modified", ["h0", "h1"]],
      ["new.ts", "renamed", []],
      ["package-lock.json", "modified", ["h2"]],
      ["src/new.ts", "added", ["h3"]],
    ],
  );
});

test("sections split hunks at line boundaries and context follows the nearest change", () => {
  assert.deepEqual(
    summary({
      sections: [
        section("Rename import", [["h0", 1, 2]]),
        section("Add constant", [["h0", 6, 6]]),
        section("Close function and add module", [
          ["h3", 0, 1],
          ["h0", 9, 10],
        ]),
        section("Move file", [], ["f1"]),
      ],
    }),
    [
      { title: "Rename import", regions: ["h0[0,5)"] },
      { title: "Add constant", regions: ["h0[5,8)"] },
      { title: "Close function and add module", regions: ["h3[0,2)", "h0[8,11)"] },
      { title: "Move file", regions: ["f1"] },
      { title: "Generated files", regions: ["h2[0,2)"] },
      { title: "Other changes", regions: ["h1[0,4)"] },
    ],
  );
});

test("unknown, reversed and out-of-range references are tolerated", () => {
  assert.deepEqual(
    summary({
      sections: [
        section("Everything", [
          ["H0", 99, -5],
          ["h9", 0, 3],
          ["h1", 0, 3],
        ], ["f1", "f42", "nonsense"]),
        section("Nothing real", [["h7", 0, 1]], ["f99"]),
      ],
    }),
    [
      { title: "Everything", regions: ["h0[0,11)", "h1[0,4)", "f1"] },
      { title: "Generated files", regions: ["h2[0,2)"] },
      { title: "Other changes", regions: ["h3[0,2)"] },
    ],
  );
});

test("the first section to claim a line keeps it, and generated files ignore claims", () => {
  assert.deepEqual(
    summary({
      sections: [
        section("First", [["h0", 0, 4]]),
        section("Second", [
          ["h0", 0, 10],
          ["h2", 0, 1],
        ]),
      ],
    }),
    [
      { title: "First", regions: ["h0[0,5)"] },
      { title: "Second", regions: ["h0[5,11)"] },
      { title: "Generated files", regions: ["h2[0,2)"] },
      { title: "Other changes", regions: ["h1[0,4)", "f1", "h3[0,2)"] },
    ],
  );
});

test("a section claiming only context is dropped", () => {
  assert.deepEqual(
    summary({ sections: [section("Context only", [["h0", 3, 5]]), section("Rest", [["h0", 0, 10]])] }),
    [
      { title: "Rest", regions: ["h0[0,11)"] },
      { title: "Generated files", regions: ["h2[0,2)"] },
      { title: "Other changes", regions: ["h1[0,4)", "f1", "h3[0,2)"] },
    ],
  );
});

test("an empty proposal still covers the whole diff", () => {
  assert.deepEqual(summary({ sections: [] }), [
    { title: "Generated files", regions: ["h2[0,2)"] },
    { title: "Other changes", regions: ["h0[0,11)", "h1[0,4)", "f1", "h3[0,2)"] },
  ]);
});

test("headings keep carriage returns and Unicode line separators", () => {
  const raw = "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@ x y z\rw\n-a\n+b\n";
  const parsed = parseDiff(raw);
  assert.equal(parsed.files[0].hunks[0].heading, " x y z\rw");
  assert.equal(serializeDiff(parsed), raw);
});

// mulberry32 in 32-bit integer math: an LCG in plain doubles loses its low bits and stops exploring.
function seeded(seed: number): (limit: number) => number {
  let state = seed;
  return (limit) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * limit);
  };
}

function randomDiff(random: (limit: number) => number): string {
  const out: string[] = [];
  for (let f = 0; f <= random(3); f++) {
    out.push(`diff --git a/f${f} b/f${f}`, `--- a/f${f}`, `+++ b/f${f}`);
    let oldStart = 1;
    for (let h = 0; h <= random(3); h++) {
      const body = Array.from({ length: 1 + random(14) }, () => [" ", "-", "+"][random(3)]);
      if (!body.some((prefix) => prefix !== " ")) body.push("+");
      const oldCount = body.filter((prefix) => prefix !== "+").length;
      const newCount = body.filter((prefix) => prefix !== "-").length;
      out.push(`@@ -${oldStart},${oldCount} +${oldStart},${newCount} @@`);
      out.push(...body.map((prefix, i) => `${prefix}line ${i}`));
      oldStart += oldCount + 10;
    }
  }
  return `${out.join("\n")}\n`;
}

function randomProposal(random: (limit: number) => number, target: ReturnType<typeof parseDiff>): Proposal {
  const hunks = [...target.hunks.values()];
  return {
    sections: Array.from({ length: random(5) }, (_, i) =>
      section(
        `S${i}`,
        Array.from({ length: random(5) }, () => {
          const hunk = hunks[random(hunks.length)];
          return [hunk.id, random(hunk.lines.length + 2) - 1, random(hunk.lines.length + 2) - 1];
        }),
        random(3) === 0 ? [`f${random(target.files.length + 1)}`] : [],
      ),
    ),
  };
}

function assertExactPartition(raw: string, proposal: Proposal): void {
  const target = parseDiff(raw);
  const guide = buildGuide(target, proposal);
  assert.equal(serializeDiff(composeGuide(target, guide)), raw, JSON.stringify(proposal));
  for (const { regions } of guide) {
    for (const region of regions) {
      if (region.kind === "file") continue;
      const lines = target.hunks.get(region.hunkId)?.lines.slice(region.start, region.end) ?? [];
      assert.ok(lines.some(isChange), `context-only region in ${JSON.stringify(proposal)}`);
    }
  }
}

test("any proposal partitions the fixture exactly, with no context-only regions", () => {
  const random = seeded(42);
  for (let round = 0; round < 500; round++) {
    assertExactPartition(RAW, randomProposal(random, diff));
  }
});

test("any proposal partitions any hunk layout exactly", () => {
  const random = seeded(7);
  for (let round = 0; round < 500; round++) {
    const raw = randomDiff(random);
    assert.equal(serializeDiff(parseDiff(raw)), raw);
    assertExactPartition(raw, randomProposal(random, parseDiff(raw)));
  }
});

test("composition rejects gaps, overlaps and duplicate files", () => {
  const whole = buildGuide(diff, { sections: [] });
  const without = (drop: string) =>
    whole.map((s) => ({ ...s, regions: s.regions.filter((r) => r.kind !== "lines" || r.hunkId !== drop) }));
  assert.throws(() => composeGuide(diff, without("h1")), /h1/);
  assert.throws(
    () => composeGuide(diff, [...whole, { id: "x", title: "x", description: "", regions: [{ kind: "lines", hunkId: "h0", start: 2, end: 4 }] }]),
    /h0/,
  );
  assert.throws(
    () => composeGuide(diff, [...whole, { id: "x", title: "x", description: "", regions: [{ kind: "file", fileIndex: 1 }] }]),
    /twice/,
  );
});

const chunkNames = (chunks: readonly DiffChunk[]) => chunks.map((c) => `${c.hunk.id}[${c.start},${c.end})`);

test("each section's blocks hold its own chunks and the chunks later sections change", () => {
  const guide = buildGuide(diff, {
    sections: [section("Imports", [["h0", 0, 2]]), section("Rest", [["h0", 3, 13], ["h1", 0, 3]])],
  });
  assert.deepEqual(
    guideBlocks(diff, guide).map((blocks) =>
      blocks.map((block) => [block.file.path, chunkNames(block.chunks), chunkNames(block.later)]),
    ),
    [
      [["src/app.ts", ["h0[0,5)"], ["h0[5,11)", "h1[0,4)"]]],
      [["src/app.ts", ["h0[5,11)", "h1[0,4)"], []]],
      [["package-lock.json", ["h2[0,2)"], []]],
      [
        ["new.ts", [], []],
        ["src/new.ts", ["h3[0,2)"], []],
      ],
    ],
  );
});

test("a block's fingerprint changes with its own changed lines and nothing else", () => {
  const proposal = { sections: [section("Imports", [["h0", 0, 2]]), section("Rest", [["h0", 3, 13]])] };
  const fingerprints = (raw: string) => {
    const parsed = parseDiff(raw);
    return guideBlocks(parsed, buildGuide(parsed, proposal))
      .slice(0, 2)
      .map((blocks) => blockFingerprint(blocks[0]));
  };
  const [imports, rest] = fingerprints(RAW);
  assert.deepEqual(fingerprints(RAW.replace("@@ -1,8 +1,9 @@", "@@ -11,8 +11,9 @@")), [imports, rest]);
  const restEdited = fingerprints(RAW.replace("+const added = 4", "+const added = 5"));
  assert.equal(restEdited[0], imports);
  assert.notEqual(restEdited[1], rest);
  assert.notEqual(fingerprints(RAW.replace("+import bee", "+import bea"))[0], imports);
});
