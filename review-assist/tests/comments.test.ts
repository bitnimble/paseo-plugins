import assert from "node:assert/strict";
import test from "node:test";
import { ReviewAttachmentSchema } from "@getpaseo/protocol/messages";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { sendReview, submitReview, workspaceAgents } from "../server/agents";
import type { ReviewStates } from "../server/review-state";
import { commentLine, commentTarget, suggestible } from "../shared/comments";
import { parseDiff } from "../shared/diff";
import { fullBlocks } from "../shared/guide";
import { DEFAULT_BRANCH_MODE, type DraftComment } from "../shared/protocol";
import { blockSides } from "../shared/sides";

const diff = parseDiff(
  [
    "diff --git a/f.ts b/f.ts",
    "index 1111111..2222222 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,4 +1,4 @@",
    " a",
    "-b",
    "+B",
    " c",
    "-d",
    "+D",
    "",
  ].join("\n"),
);
const [block] = fullBlocks(diff);
const sides = blockSides(block, "a\nB\nc\nD\n", false);

function draft(target: NonNullable<ReturnType<typeof commentTarget>>, id: string, body: string): DraftComment {
  return { ...target, id, body, suggestion: null, createdAt: "2026-10-21T00:00:00.000Z" };
}

test("only new-side lines all in the comment's context can take a suggestion", () => {
  const added = commentTarget(block.file, sides.modified.lines, 1, 3);
  const removed = commentTarget(block.file, sides.original.lines, 1, 1);
  assert.ok(added != null && removed != null);
  assert.equal(suggestible(added), "B\nc\nD");
  assert.equal(suggestible(removed), null);
  assert.equal(suggestible({ ...added, context: { ...added.context, lines: [] } }), null);
});

test("a comment over a huge range keeps its range but carries only the lines nearest its anchor", () => {
  const lines = Array.from({ length: 50_000 }, (_, i) => ({ text: `l${i + 1}`, oldNumber: i + 1, newNumber: i + 1 }));
  const target = commentTarget(block.file, lines, 0, lines.length - 1);
  assert.ok(target != null);
  assert.deepEqual([target.startLine, target.lineNumber], [1, 50_000]);
  assert.equal(target.context.lines.length, 1000);
  assert.equal(target.context.lines.at(-1)?.content, "l50000");
  assert.equal(suggestible(target), null);
});

test("a comment anchors on its last line, in the file that line exists in", () => {
  const added = commentTarget(block.file, sides.modified.lines, 1, 3);
  assert.deepEqual(added, {
    filePath: "f.ts",
    side: "new",
    startLine: 2,
    lineNumber: 4,
    context: {
      hunkHeader: "@@ -1,4 +1,4 @@",
      targetLine: { oldLineNumber: null, newLineNumber: 4, type: "add", content: "D" },
      lines: [
        { oldLineNumber: 1, newLineNumber: 1, type: "context", content: "a" },
        { oldLineNumber: null, newLineNumber: 2, type: "add", content: "B" },
        { oldLineNumber: 3, newLineNumber: 3, type: "context", content: "c" },
        { oldLineNumber: null, newLineNumber: 4, type: "add", content: "D" },
      ],
    },
  });
  const removed = commentTarget(block.file, sides.original.lines, 1, 1);
  assert.equal(removed?.side, "old");
  assert.equal(removed?.lineNumber, 2);
  assert.equal(removed?.context.targetLine.type, "remove");

  assert.ok(added != null && removed != null);
  assert.equal(commentLine(draft(added, "1", ""), sides.modified.lines), 3);
  assert.equal(commentLine(draft(added, "1", ""), sides.original.lines), -1);
  assert.equal(commentLine(draft(removed, "2", ""), sides.original.lines), 1);
});

test("comments go to the agent as Paseo's review attachment, steering its turn", async () => {
  const added = commentTarget(block.file, sides.modified.lines, 1, 3);
  const removed = commentTarget(block.file, sides.original.lines, 1, 1);
  assert.ok(added != null && removed != null);
  const sent: { id: string; text: string; options: { activeTurnBehavior?: string; attachments?: unknown[] } }[] = [];
  const agent = (id: string, workspaceId: string, extra: object = {}) => ({
    agent: { id, workspaceId, title: id, provider: "claude", status: "idle", labels: {}, archivedAt: null, updatedAt: "2026-10-01", lastUserMessageAt: null, ...extra },
  });
  const paseo = {
    agents: {
      list: async () => ({
        entries: [
          agent("old", "w", { lastUserMessageAt: "2026-10-02" }),
          agent("recent", "w", { lastUserMessageAt: "2026-10-20" }),
          agent("elsewhere", "other"),
          agent("archived", "w", { archivedAt: "2026-10-03" }),
          agent("segmenter", "w", { labels: { "review-assist": "segment" } }),
        ],
      }),
      ref: (id: string) => ({
        send: async (text: string, options: (typeof sent)[number]["options"]) => {
          sent.push({ id, text, options });
        },
      }),
    },
  } as unknown as PluginHandlerContext["paseo"];

  assert.deepEqual(
    (await workspaceAgents(paseo, "w")).map(({ id }) => id),
    ["recent", "old"],
  );

  await sendReview(paseo, {
    directory: "/repo",
    mode: DEFAULT_BRANCH_MODE,
    baseRef: "abc123",
    reviewer: { kind: "agent", id: "recent" },
    message: "  ",
    comments: [draft(added, "1", "Name these."), draft(removed, "2", "Keep b.\nIt's used.")],
    applied: [draft({ ...added, startLine: 1, lineNumber: 1 }, "3", "")],
  });
  const [{ id, text, options }] = sent;
  assert.equal(id, "recent");
  assert.equal(
    text,
    "Please address these review comments.\n\n- f.ts lines 2–4: Name these.\n- f.ts line 2 of the old file: Keep b.\n  It's used.\n\nI've already made these edits myself:\n- f.ts line 1",
  );
  assert.equal(options.activeTurnBehavior, "steer");
  const attachment = ReviewAttachmentSchema.parse(options.attachments?.[0]);
  assert.equal(attachment.mode, "base");
  assert.equal(attachment.baseRef, "abc123");
  assert.deepEqual(
    attachment.comments.map(({ filePath, side, lineNumber, body }) => [filePath, side, lineNumber, body]),
    [
      ["f.ts", "new", 4, "Lines 2–4: Name these."],
      ["f.ts", "old", 2, "Keep b.\nIt's used."],
    ],
  );
});

test("submitting needs an agent unless every comment is a suggested edit, and comments not yet sent", async () => {
  const added = commentTarget(block.file, sides.modified.lines, 1, 1);
  assert.ok(added != null);
  const states = {
    read: async () => ({ viewed: [], comments: [draft(added, "1", "Rename.")] }),
  } as unknown as ReviewStates;
  const paseo = {} as PluginHandlerContext["paseo"];
  const submit = (commentIds: string[]) =>
    submitReview(paseo, states, { directory: "/repo", mode: DEFAULT_BRANCH_MODE, baseRef: "abc123", reviewer: null, message: "", commentIds });

  assert.deepEqual(await submit(["1"]), { status: "failed", error: "Pick an agent for the comments." });
  assert.deepEqual(await submit(["gone"]), { status: "failed", error: "These comments were already sent or deleted." });
});

test("with no agent to send to, the comments start one in the workspace", async () => {
  const added = commentTarget(block.file, sides.modified.lines, 1, 1);
  assert.ok(added != null);
  const created: { workspaceId: string; input: { config: object; prompt: string; attachments: unknown[] } }[] = [];
  const paseo = {
    workspaces: {
      ref: (workspaceId: string) => ({
        agents: {
          create: async (input: (typeof created)[number]["input"]) => {
            created.push({ workspaceId, input });
          },
        },
      }),
    },
  } as unknown as PluginHandlerContext["paseo"];

  await sendReview(paseo, {
    directory: "/repo",
    mode: DEFAULT_BRANCH_MODE,
    baseRef: "abc123",
    reviewer: { kind: "new", workspaceId: "w", model: "claude/opus", modeId: "plan", thinkingOptionId: null },
    message: "",
    comments: [draft(added, "1", "Rename.")],
  });
  const [{ workspaceId, input }] = created;
  assert.equal(workspaceId, "w");
  assert.deepEqual(input.config, { provider: "claude/opus", modeId: "plan" });
  assert.equal(input.prompt, "Please address these review comments.\n\n- f.ts line 2: Rename.");
  assert.equal(ReviewAttachmentSchema.parse(input.attachments[0]).comments[0].body, "Rename.");
});
