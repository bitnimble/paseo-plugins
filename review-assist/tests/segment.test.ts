import assert from "node:assert/strict";
import test from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  ModelFallback,
  PROMPT_BUDGET_CHARS,
  PROPOSAL_JSON_SCHEMA,
  SegmentError,
  diffChunks,
  mergeSections,
  parseProposal,
  proposeSections,
  segmentPrompt,
} from "../server/segment";
import type { ContextLine, PromptContext } from "../server/prompt-context";
import { parseDiff } from "../shared/diff";
import { messageOf } from "../shared/errors";

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

test("a file over budget is split between hunks, its header repeated in each part", () => {
  const hunks = [10, 20, 30, 40].map((line) => `@@ -${line} +${line} @@\n-old ${line}\n+new ${line}\n`).join("");
  const raw = `diff --git a/big.ts b/big.ts\nindex 1111111..2222222 100644\n--- a/big.ts\n+++ b/big.ts\n${hunks}${THREE_FILES}`;
  const diff = parseDiff(raw);
  const [one] = diffChunks(diff, PROMPT_BUDGET_CHARS);
  const hunk = /^HUNK h0 [^]*?(?=^HUNK h1 )/m.exec(one)?.[0] ?? "";
  const parts = diffChunks(diff, "FILE f0 big.ts (modified)\n".length + hunk.length * 3);
  assert.deepEqual(
    parts.map((part) => [...part.matchAll(/^(?:FILE f\d (\S+)|HUNK (h\d))/gm)].map((match) => match[1] ?? match[2])),
    [["big.ts", "h0", "h1", "h2"], ["big.ts", "h3", "a.ts", "h4"], ["b.ts", "h5", "c.ts", "h6"]],
  );
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
    models: new ModelFallback(["fake/model"]),
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
    proposeSections(paseoAnswering(answer), {
      workspaceId: "w",
      models: new ModelFallback(["m"]),
      diff,
      budget: perFile,
      onAgent: () => {},
    });

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
  await assert.rejects(run(() => "no idea"), (error: unknown) => {
    assert.ok(error instanceof SegmentError);
    assert.match(error.message, /answer was unusable/);
    assert.equal(error.agentId, "f0");
    return true;
  });
  assert.deepEqual(archived, ["f1", "f2"]);
});

test("a diff of only generated files asks no agent", async () => {
  const lockOnly = RAW.slice(RAW.indexOf("diff --git a/yarn.lock"));
  const paseo = { workspaces: { ref: () => assert.fail("asked an agent") } } as unknown as PluginHandlerContext["paseo"];
  const proposal = await proposeSections(paseo, {
    workspaceId: "w",
    models: new ModelFallback(["m"]),
    diff: parseDiff(lockOnly),
    onAgent: () => {},
  });
  assert.deepEqual(proposal, { sections: [] });
});

const TWO_HUNKS = parseDiff(`diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -3,1 +3,1 @@
-x
+X
@@ -6,1 +6,1 @@
-y
+Y
`);
const line = (number: number, text: string): ContextLine => ({ number, text });
const TWO_HUNKS_CONTEXT: PromptContext = new Map([
  ["h0", { side: "new", scope: [line(1, "class A {")], before: [line(2, "  run() {")], after: [line(4, "m1"), line(5, "m2")] }],
  [
    "h1",
    {
      side: "new",
      scope: [line(1, "class A {"), line(2, "  run() {")],
      before: [line(4, "m1"), line(5, "m2")],
      after: [line(7, "  }")],
    },
  ],
]);
const hunksOf = (chunk: string): string => chunk.slice(chunk.indexOf("HUNK"));

test("context is unnumbered around a hunk's numbered lines, and a later hunk leaves out what's already shown", () => {
  const [chunk] = diffChunks(TWO_HUNKS, PROMPT_BUDGET_CHARS, TWO_HUNKS_CONTEXT);

  assert.equal(
    hunksOf(chunk),
    [
      "HUNK h0 lines 0-1 @@ -3,1 +3,1 @@",
      "scope\t class A {",
      "near\t   run() {",
      "0\t-x",
      "1\t+X",
      "near\t m1",
      "near\t m2",
      "HUNK h1 lines 0-1 @@ -6,1 +6,1 @@",
      "0\t-y",
      "1\t+Y",
      "near\t   }",
      "",
    ].join("\n"),
  );
});

test("a file split across parts repeats the context each part needs", () => {
  const parts = diffChunks(TWO_HUNKS, 1, TWO_HUNKS_CONTEXT);

  assert.equal(parts.length, 2);
  assert.equal(
    hunksOf(parts[1]),
    [
      "HUNK h1 lines 0-1 @@ -6,1 +6,1 @@",
      "scope\t class A {",
      "scope\t   run() {",
      "near\t m1",
      "near\t m2",
      "0\t-y",
      "1\t+Y",
      "near\t   }",
      "",
    ].join("\n"),
  );
});

test("a header hidden in the elided middle of a huge hunk is still shown for a later hunk", () => {
  const added = Array.from({ length: 400 }, (_, index) => `+l${index + 1}`).join("\n");
  const diff = parseDiff(`diff --git a/big.ts b/big.ts
index 1111111..2222222 100644
--- a/big.ts
+++ b/big.ts
@@ -0,0 +1,400 @@
${added}
@@ -100,1 +500,1 @@
-z
+Z
`);
  const context: PromptContext = new Map([
    ["h0", { side: "new", scope: [], before: [], after: [] }],
    ["h1", { side: "new", scope: [line(10, "l10"), line(320, "function middle() {")], before: [], after: [] }],
  ]);

  const [chunk] = diffChunks(diff, PROMPT_BUDGET_CHARS, context);

  assert.match(chunk, /HUNK h1 lines 0-1 @@ -100,1 \+500,1 @@\nscope\t function middle\(\) \{\n0\t-z\n/);
});

const USABLE = JSON.stringify({ sections: [{ title: "Done", description: "" }] });
type Finish = {
  status: string;
  lastMessage: string | null;
  error: string | null;
  final?: { pendingPermissions: { id: string }[] };
};
type PermissionReply = { requestId: string; response: { behavior: string; message?: string } };
const idle = (lastMessage: string | null): Finish => ({ status: "idle", lastMessage, error: null });
const errored = (error: string): Finish => ({ status: "error", lastMessage: null, error });
const asking = (...ids: string[]): Finish => ({
  status: "permission",
  lastMessage: null,
  error: null,
  final: { pendingPermissions: ids.map((id) => ({ id })) },
});

/**
 * Agents named `<model>#<n>`; `finish` decides how each model's agents end, as one result or a
 * sequence whose last repeats, and throwing rejects the create.
 */
function fallbackPaseo(finish: (model: string, prompt: string) => Finish | Finish[]) {
  const created: string[] = [];
  const archived: string[] = [];
  const replies: PermissionReply[] = [];
  const waits: number[] = [];
  const paseo = {
    workspaces: {
      ref: () => ({
        agents: {
          create: async ({ prompt, config }: { prompt: string; config: { provider: string } }) => {
            const id = `${config.provider}#${created.push(config.provider)}`;
            const results = [finish(config.provider, prompt)].flat();
            return {
              id,
              waitForFinish: async (timeoutMs: number) => {
                waits.push(timeoutMs);
                return results.length > 1 ? results.shift() : results[0];
              },
              respondToPermission: async (reply: PermissionReply) => {
                replies.push(reply);
              },
              archive: async () => {
                archived.push(id);
                return {};
              },
            };
          },
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
  } as unknown as PluginHandlerContext["paseo"];
  return { paseo, created, archived, replies, waits };
}

const proposeWithBackup = (paseo: PluginHandlerContext["paseo"], models = new ModelFallback(["main", "backup"])) =>
  proposeSections(paseo, { workspaceId: "w", models, diff: parseDiff(THREE_FILES), onAgent: () => {} });

const titles = (proposal: { sections: readonly { title: string }[] }): string[] =>
  proposal.sections.map(({ title }) => title);

test("a failed run on the first model moves to the backup, archiving the failed agent", async () => {
  const failures: [string, Finish][] = [
    ["an error", errored("quota exceeded")],
    ["nothing returned", idle(null)],
    ["a limit reported as plain text", idle("You've hit your limit")],
  ];
  for (const [name, failure] of failures) {
    const { paseo, created, archived } = fallbackPaseo((model) => (model === "main" ? failure : idle(USABLE)));
    const models = new ModelFallback(["main", "backup"]);

    assert.deepEqual(titles(await proposeWithBackup(paseo, models)), ["Done"], name);

    assert.deepEqual(created, ["main", "backup"], name);
    assert.deepEqual(archived, ["main#1", "backup#2"], name);
    assert.equal(models.current, "backup", name);
  }
});

test("an answer followed by more talk, such as a Stop hook's reply, is still found", async () => {
  const created: string[] = [];
  const assistant = (text: string) => ({ item: { type: "assistant_message", text } });
  const paseo = {
    workspaces: {
      ref: () => ({
        agents: {
          create: async ({ config }: { config: { provider: string } }) => ({
            id: `${config.provider}#${created.push(config.provider)}`,
            waitForFinish: async () => idle("Not mine to fix."),
            timeline: {
              refetch: async () => ({
                entries: [
                  assistant(JSON.stringify({ sections: [{ title: "Stale", description: "" }] })),
                  assistant(USABLE),
                  { item: { type: "user_message", text: "Stop hook feedback" } },
                  assistant("Not mine to fix."),
                ],
              }),
            },
            archive: async () => ({}),
          }),
        },
      }),
    },
  } as unknown as PluginHandlerContext["paseo"];

  assert.deepEqual(titles(await proposeWithBackup(paseo)), ["Done"]);
  assert.deepEqual(created, ["main"]);
});

test("permission requests are each denied once, waited out while still listed, and the agent carries on", async () => {
  const { paseo, created, replies, waits } = fallbackPaseo(() => [
    asking("edit-1", "bash-1"),
    asking("edit-1"),
    idle(USABLE),
  ]);

  assert.deepEqual(titles(await proposeWithBackup(paseo)), ["Done"]);

  assert.deepEqual(created, ["main"]);
  assert.deepEqual(
    replies.map(({ requestId, response }) => [requestId, response.behavior, response.message != null]),
    [
      ["edit-1", "deny", true],
      ["bash-1", "deny", true],
    ],
  );
  assert.equal(waits.length, 3);
  assert.ok(waits.every(Number.isInteger), `whole-millisecond timeouts, got ${waits.join(", ")}`);
});

test("a model that cannot start an agent moves to the backup", async () => {
  const { paseo, created, archived } = fallbackPaseo((model) => {
    if (model === "main") throw new Error("provider unavailable");
    return idle(USABLE);
  });

  assert.deepEqual(titles(await proposeWithBackup(paseo)), ["Done"]);

  assert.deepEqual(created, ["main", "backup"]);
  assert.deepEqual(archived, ["backup#2"]);
});

test("an agent out of time is stopped and the run ends without trying the backup", async () => {
  const { paseo, created, archived } = fallbackPaseo(() => ({ status: "timeout", lastMessage: null, error: null }));

  await assert.rejects(proposeWithBackup(paseo), (error: unknown) => {
    assert.ok(error instanceof SegmentError);
    assert.match(error.message, /did not finish in time/);
    assert.equal(error.agentId, "main#1");
    return true;
  });

  assert.deepEqual(created, ["main"]);
  assert.deepEqual(archived, ["main#1"]);
});

test("losing track of a running agent stops the run, so no backup runs alongside it", async () => {
  const created: string[] = [];
  const paseo = {
    workspaces: {
      ref: () => ({
        agents: {
          create: async ({ config }: { config: { provider: string } }) => {
            created.push(config.provider);
            return {
              id: "lost",
              waitForFinish: async () => {
                throw new Error("connection closed");
              },
            };
          },
        },
      }),
    },
  } as unknown as PluginHandlerContext["paseo"];

  await assert.rejects(proposeWithBackup(paseo), (error: unknown) => {
    assert.ok(error instanceof SegmentError);
    assert.equal(error.message, "connection closed");
    assert.equal(error.agentId, "lost");
    return true;
  });
  assert.deepEqual(created, ["main"]);
});

test("when the backup fails too, the error names both failures and keeps the last agent", async () => {
  const { paseo, archived } = fallbackPaseo((model) =>
    model === "main" ? idle("You've hit your limit") : errored("backup is down"),
  );

  await assert.rejects(proposeWithBackup(paseo), (error: unknown) => {
    assert.ok(error instanceof SegmentError);
    assert.equal(
      error.message,
      "main failed: The guided review agent's answer was unusable: no JSON object in the answer. It said: You've hit your limit\nbackup failed: backup is down",
    );
    assert.equal(error.agentId, "backup#2");
    return true;
  });
  assert.deepEqual(archived, ["main#1"]);
});

test("the first model's reason survives a backup that gets stuck or cannot start", async () => {
  const onStuck = fallbackPaseo((model) =>
    model === "main" ? errored("quota exceeded") : { status: "timeout", lastMessage: null, error: null },
  );
  await assert.rejects(proposeWithBackup(onStuck.paseo), (error: unknown) => {
    assert.ok(error instanceof SegmentError);
    assert.equal(
      error.message,
      "main failed: quota exceeded\nbackup failed: The guided review agent did not finish in time and was stopped.",
    );
    assert.equal(error.agentId, "backup#2");
    return true;
  });

  const onCreate = fallbackPaseo((model) => {
    if (model === "backup") throw new Error("provider unavailable");
    return errored("quota exceeded");
  });
  await assert.rejects(proposeWithBackup(onCreate.paseo), (error: unknown) => {
    assert.ok(!(error instanceof SegmentError));
    assert.equal(messageOf(error), "main failed: quota exceeded\nbackup failed: provider unavailable");
    return true;
  });
});

test("one model alone keeps its own message", async () => {
  const { paseo } = fallbackPaseo(() => errored("quota exceeded"));
  await assert.rejects(proposeWithBackup(paseo, new ModelFallback(["main"])), (error: unknown) => {
    assert.equal(messageOf(error), "quota exceeded");
    return true;
  });
});

test("a dead first model is dropped: parts already running retry on the backup, and later parts start there", async () => {
  const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
  const raw = paths
    .map((path) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`)
    .join("");
  const diff = parseDiff(raw);
  const perFile = diffChunks(diff, PROMPT_BUDGET_CHARS)[0].length / paths.length;
  const asked: string[] = [];
  const { paseo, created } = fallbackPaseo((model, prompt) => {
    asked.push(`${model} ${/^FILE f\d (\S+)/m.exec(prompt)?.[1] ?? "merge"}`);
    if (model === "main") return errored("quota exceeded");
    if (prompt.includes("<sections>")) return idle(JSON.stringify({ sections: [] }));
    return idle(USABLE);
  });
  const models = new ModelFallback(["main", "backup"]);

  const proposal = await proposeSections(paseo, { workspaceId: "w", models, diff, budget: perFile, onAgent: () => {} });

  // Four parts run at once, so all four reach the first model before any has failed.
  assert.deepEqual(created.slice(0, 4), ["main", "main", "main", "main"]);
  assert.deepEqual(created.slice(4), Array(7).fill("backup"));
  assert.deepEqual(asked.slice(0, 4), ["main a.ts", "main b.ts", "main c.ts", "main d.ts"]);
  assert.deepEqual(asked.slice(4).sort(), [
    "backup a.ts",
    "backup b.ts",
    "backup c.ts",
    "backup d.ts",
    "backup e.ts",
    "backup f.ts",
    "backup merge",
  ]);
  assert.deepEqual(titles(proposal), Array(6).fill("Done"));
  assert.equal(models.current, "backup");
});

test("parts reporting the same model never skip the last one", () => {
  const models = new ModelFallback(["main", "backup"]);
  assert.equal(models.current, "main");
  assert.equal(models.failed("main"), "backup");
  assert.equal(models.failed("main"), "backup");
  assert.equal(models.current, "backup");
  assert.equal(models.failed("backup"), null);
  assert.equal(models.current, "backup");
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
