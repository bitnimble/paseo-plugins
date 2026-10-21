import assert from "node:assert/strict";
import test from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  PROMPT_BUDGET_CHARS,
  PROPOSAL_JSON_SCHEMA,
  diffChunks,
  mergeSections,
  parseProposal,
  proposeSections,
  segmentPrompt,
} from "../server/segment";
import { parseDiff } from "../shared/diff";

const RAW = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@ export function main() {
 keep
-old
+new
diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/yarn.lock b/yarn.lock
index 3333333..4444444 100644
--- a/yarn.lock
+++ b/yarn.lock
@@ -1 +1 @@
-a
+b
`;

const promptFor = (raw: string) => segmentPrompt(diffChunks(parseDiff(raw), PROMPT_BUDGET_CHARS)[0], null);

test("the prompt numbers lines per hunk and leaves out generated files", () => {
  const prompt = promptFor(RAW);
  assert.match(prompt, /^FILE f0 src\/app\.ts \(modified\)$/m);
  assert.match(prompt, /^HUNK h0 lines 0-2 @@ -1,2 \+1,2 @@ export function main\(\) \{$/m);
  assert.match(prompt, /^0\t keep\n1\t-old\n2\t\+new$/m);
  assert.match(prompt, /^FILE f1 new\.ts \(renamed from old\.ts, no line changes\)$/m);
  assert.doesNotMatch(prompt, /yarn\.lock/);
  assert.match(
    prompt,
    /^\{"sections":\[\{"title":"…","description":"…","regions":\[\{"hunk":"h0","from":0,"to":12\}\],"files":\["f3"\]\}\]\}$/m,
  );
});

test("huge hunks are elided in the middle but keep their real line numbers", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `+line ${i}`);
  const raw = `diff --git a/big.ts b/big.ts\nnew file mode 100644\n--- /dev/null\n+++ b/big.ts\n@@ -0,0 +1,1000 @@\n${lines.join("\n")}\n`;
  const prompt = promptFor(raw);
  assert.match(prompt, /^299\t\+line 299$/m);
  assert.doesNotMatch(prompt, /^300\t/m);
  assert.match(prompt, /^…\tlines 300-949 not shown: 650 added, 0 removed$/m);
  assert.match(prompt, /^950\t\+line 950$/m);
  assert.match(prompt, /^999\t\+line 999$/m);
});

test("answers parse with or without surrounding prose and reject the wrong shape", () => {
  const answer = { sections: [{ title: "T", description: "D", regions: [{ hunk: "h0", from: 0, to: 2 }], files: [] }] };
  assert.deepEqual(parseProposal(JSON.stringify(answer)), answer);
  assert.deepEqual(parseProposal("```json\n" + JSON.stringify(answer) + "\n```"), answer);
  assert.throws(() => parseProposal("no idea"), /no JSON/);
  assert.throws(() => parseProposal('{"sections":[{"title":"T"}]}'));
  assert.deepEqual(parseProposal('{"sections":[{"title":"T","description":"D"}]}'), {
    sections: [{ title: "T", description: "D", regions: [], files: [] }],
  });
});

const THREE_FILES = ["a.ts", "b.ts", "c.ts"]
  .map((path) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`)
  .join("");

test("a diff over budget is packed into parts in path order without splitting a file", () => {
  const diff = parseDiff(THREE_FILES);
  const [one] = diffChunks(diff, PROMPT_BUDGET_CHARS);
  const perFile = one.length / 3;
  const parts = diffChunks(diff, perFile * 2);
  assert.equal(parts.length, 2);
  assert.deepEqual(
    parts.map((part) => [...part.matchAll(/^FILE f\d (\S+)/gm)].map((match) => match[1])),
    [["a.ts", "b.ts"], ["c.ts"]],
  );
  assert.equal(parts.join(""), one);
});

test("a diff over budget runs one agent per part, then merges and orders their sections", async () => {
  const prompts: string[] = [];
  let archived = 0;
  const answerFor = (prompt: string): unknown => {
    if (prompt.includes("<sections>")) {
      return {
        sections: [
          { title: "Core", description: "Merged.", parts: ["s1", "s0"] },
          { title: "Bogus", description: "Unknown ids.", parts: ["s9", "x"] },
        ],
      };
    }
    const hunks = [...prompt.matchAll(/^HUNK (h\d)/gm)].map((match) => match[1]);
    return { sections: hunks.map((hunk) => ({ title: hunk, description: "", regions: [{ hunk, from: 0, to: 1 }], files: [] })) };
  };
  const paseo = {
    workspaces: {
      ref: () => ({
        agents: {
          create: async ({ prompt }: { prompt: string }) => ({
            id: `agent-${prompts.push(prompt)}`,
            waitForFinish: async () => ({ status: "idle", lastMessage: JSON.stringify(answerFor(prompt)), error: null }),
            archive: async () => {
              archived++;
              return {};
            },
          }),
        },
      }),
    },
  } as unknown as PluginHandlerContext["paseo"];
  const diff = parseDiff(THREE_FILES);
  const perFile = diffChunks(diff, PROMPT_BUDGET_CHARS)[0].length / 3;
  const agents: string[] = [];

  const proposal = await proposeSections(paseo, {
    workspaceId: "w",
    model: "fake/model",
    diff,
    budget: perFile * 2,
    onAgent: (id) => agents.push(id),
  });

  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /part 1 of 2/);
  assert.match(prompts[1], /part 2 of 2/);
  assert.match(prompts[2], /^s0: h0\n {2}\n {2}files: a\.ts$/m);
  assert.deepEqual(agents, ["agent-1", "agent-2", "agent-3"]);
  assert.equal(archived, 3);
  assert.deepEqual(
    proposal.sections.map(({ title, regions }) => [title, regions.map(({ hunk }) => hunk)]),
    [
      ["Core", ["h1", "h0"]],
      ["h2", ["h2"]],
    ],
  );
});

test("a failed part leaves its lines unplaced, and only all parts failing fails the run", async () => {
  const diff = parseDiff(THREE_FILES);
  const perFile = diffChunks(diff, PROMPT_BUDGET_CHARS)[0].length / 3;
  const archived: string[] = [];
  const paseoAnswering = (answer: (prompt: string) => string) =>
    ({
      workspaces: {
        ref: () => ({
          agents: {
            create: async ({ prompt }: { prompt: string }) => ({
              id: prompt.includes("<sections>") ? "merge" : (/^FILE (f\d)/m.exec(prompt)?.[1] ?? "?"),
              waitForFinish: async () => ({ status: "idle", lastMessage: answer(prompt), error: null }),
              archive: async () => ({}),
            }),
          },
        }),
      },
      agents: {
        ref: (id: string) => ({
          archive: async () => {
            archived.push(id);
            return {};
          },
        }),
      },
    }) as unknown as PluginHandlerContext["paseo"];
  const run = (answer: (prompt: string) => string) =>
    proposeSections(paseoAnswering(answer), { workspaceId: "w", model: "m", diff, budget: perFile, onAgent: () => {} });

  const partial = await run((prompt) =>
    prompt.includes("FILE f1")
      ? "no idea"
      : prompt.includes("<sections>")
        ? "unusable merge"
        : JSON.stringify({ sections: [{ title: prompt.includes("FILE f0") ? "A" : "C", description: "" }] }),
  );
  assert.deepEqual(
    partial.sections.map(({ title }) => title),
    ["A", "C"],
  );
  assert.deepEqual(archived, ["f1", "merge"]);

  archived.length = 0;
  await assert.rejects(run(() => "no idea"), /answer was unusable/);
  assert.deepEqual(archived, []);
});

test("a diff of only generated files asks no agent", async () => {
  const lockOnly = RAW.slice(RAW.indexOf("diff --git a/yarn.lock"));
  const paseo = { workspaces: { ref: () => assert.fail("asked an agent") } } as unknown as PluginHandlerContext["paseo"];
  const proposal = await proposeSections(paseo, { workspaceId: "w", model: "m", diff: parseDiff(lockOnly), onAgent: () => {} });
  assert.deepEqual(proposal, { sections: [] });
});

test("merging keeps a section named twice where first named", () => {
  const section = (title: string) => ({ title, description: "", regions: [], files: [title] });
  const merged = mergeSections([section("a"), section("b")], {
    sections: [
      { title: "B", description: "", parts: ["s1"] },
      { title: "AB", description: "", parts: ["s0", "s1"] },
    ],
  });
  assert.deepEqual(
    merged.map(({ title, files }) => [title, files]),
    [
      ["B", ["b"]],
      ["AB", ["a"]],
    ],
  );
});

test("the output schema is strict and carries no numeric bounds", () => {
  const text = JSON.stringify(PROPOSAL_JSON_SCHEMA);
  assert.doesNotMatch(text, /minimum|maximum/);
  assert.match(text, /"additionalProperties":false/);
});
