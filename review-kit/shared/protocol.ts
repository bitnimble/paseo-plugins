import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Failed } from "./errors";

export const diffModeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }),
  /** `branch` null is the repository's default branch. */
  z.object({ kind: z.literal("branch"), branch: z.string().nullable() }),
]);
export type DiffMode = z.infer<typeof diffModeSchema>;

export const DEFAULT_BRANCH_MODE: DiffMode = { kind: "branch", branch: null };
export const UNCOMMITTED_MODE: DiffMode = { kind: "uncommitted" };

export function modeKey(mode: DiffMode): string {
  if (mode.kind === "uncommitted") return "uncommitted";
  return mode.branch == null ? "branch" : `branch:${mode.branch}`;
}

/** What a review is of: the changes in `directory` that `mode` picks. */
export const targetFields = { directory: z.string(), mode: diffModeSchema };

export const failedSchema = z.object({ status: z.literal("failed"), error: z.string() }) satisfies z.ZodType<Failed>;

const deflatedSchema = z.object({ deflated: z.string() }).strict();
/** An output's JSON, raw-deflated and base64-encoded. */
export type Deflated = z.infer<typeof deflatedSchema>;

export function isDeflated(output: unknown): output is Deflated {
  return deflatedSchema.safeParse(output).success;
}

/** Large outputs arrive `Deflated`; read them with `usePackedRpc`. */
export function definePackedRpc<Input extends z.ZodType, Output extends z.ZodType>(definition: {
  name: string;
  input: Input;
  output: Output;
}) {
  return defineRpc({ ...definition, output: z.union([deflatedSchema, definition.output]) });
}

const updateStatusSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    current: z.string(),
    target: z.string(),
    /** Links to the changes between the two. */
    review: z.string().nullable(),
    /** Why the last attempt to install it failed. */
    failure: z.string().nullable(),
  }),
  z.object({ status: z.literal("updating") }),
  z.object({ status: z.literal("current"), revision: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const updateStatusRpc = defineRpc({
  name: "review.update.status",
  input: z.object({}),
  output: updateStatusSchema,
});

/** Starts installing the update, which restarts the plugin once it's built. */
export const updateRpc = defineRpc({
  name: "review.update.apply",
  input: z.object({}),
  output: z.object({}),
});

const MAX_MARKDOWN_CHARS = 500_000;

const markdownChangeSchema = z.enum(["added", "removed"]);

const markdownRunSchema = z.object({
  text: z.string(),
  strong: z.boolean(),
  em: z.boolean(),
  code: z.boolean(),
  strike: z.boolean(),
  /** A link's target, or an image's source when `image`; `text` is then the image's alt text. */
  href: z.string().nullable(),
  image: z.boolean(),
  change: markdownChangeSchema.nullable(),
});
export type MarkdownRun = z.infer<typeof markdownRunSchema>;

const markdownBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heading"), depth: z.number().int(), runs: z.array(markdownRunSchema) }),
  z.object({ kind: z.literal("text"), runs: z.array(markdownRunSchema) }),
  z.object({
    kind: z.literal("code"),
    lines: z.array(z.object({ text: z.string(), change: markdownChangeSchema.nullable() })),
  }),
  z.object({
    kind: z.literal("table"),
    columns: z.array(
      z.object({ align: z.enum(["left", "center", "right"]).nullable(), change: markdownChangeSchema.nullable() }),
    ),
    rows: z.array(
      z.object({
        header: z.boolean(),
        cells: z.array(z.array(markdownRunSchema)),
        change: markdownChangeSchema.nullable(),
      }),
    ),
  }),
  z.object({ kind: z.literal("rule") }),
]);
export type MarkdownBlock = z.infer<typeof markdownBlockSchema>;

const markdownEntrySchema = z.object({
  /** `changed` blocks mark their removed and added parts, none when only a list marker or quote depth changed. */
  change: z.enum(["same", "added", "removed", "changed"]),
  /** How many quotes the block is inside. */
  quote: z.number().int(),
  /** `marker` is on an item's first block, and null on the blocks after it in the same item. */
  list: z.object({ depth: z.number().int(), marker: z.string().nullable() }).nullable(),
  block: markdownBlockSchema,
  /** Lines of `before` (old) or `after` (new), from 0, the block is written on; null when not found. */
  lines: z.object({ side: z.enum(["old", "new"]), start: z.number().int(), end: z.number().int() }).nullable(),
});
export type MarkdownEntry = z.infer<typeof markdownEntrySchema>;

const markdownOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), entries: z.array(markdownEntrySchema) }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type MarkdownOutcome = z.infer<typeof markdownOutcomeSchema>;

/** The document as `after` renders it, with what `before` had in its place. */
export const markdownRpc = definePackedRpc({
  name: "review.markdown",
  input: z.object({ before: z.string().max(MAX_MARKDOWN_CHARS), after: z.string().max(MAX_MARKDOWN_CHARS) }),
  output: markdownOutcomeSchema,
});

/** A file seen as one section showed it, which lapses once that part of the diff changes. */
const viewedMarkSchema = z.object({ path: z.string(), fingerprint: z.string() });
export type ViewedMark = z.infer<typeof viewedMarkSchema>;

/** Paseo's review attachment context line. */
const contextLineSchema = z.object({
  oldLineNumber: z.number().int().positive().nullable(),
  newLineNumber: z.number().int().positive().nullable(),
  type: z.enum(["add", "remove", "context"]),
  content: z.string(),
});
export type ContextLine = z.infer<typeof contextLineSchema>;

/** Lines `startLine` to `lineNumber` of the diff's old or new file. */
export const draftCommentSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  side: z.enum(["old", "new"]),
  startLine: z.number().int().positive(),
  lineNumber: z.number().int().positive(),
  body: z.string(),
  context: z.object({ hunkHeader: z.string(), targetLine: contextLineSchema, lines: z.array(contextLineSchema) }),
  /** New-side lines `startLine` to `lineNumber` as they were, and what to replace them with, joined by "\n". */
  suggestion: z.object({ original: z.string(), replacement: z.string() }).nullable().default(null),
  createdAt: z.string(),
});
export type DraftComment = z.infer<typeof draftCommentSchema>;

export const reviewStateSchema = z.object({
  viewed: z.array(viewedMarkSchema),
  comments: z.array(draftCommentSchema),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const stateRpc = definePackedRpc({
  name: "review.state",
  input: z.object(targetFields),
  output: reviewStateSchema,
});

const stateChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("viewed"), marks: z.array(viewedMarkSchema).readonly(), viewed: z.boolean() }),
  /** Drops the `remove` ids, then saves each of `save` over any comment with its id. */
  z.object({
    kind: z.literal("comments"),
    remove: z.array(z.string()).readonly(),
    save: z.array(draftCommentSchema).readonly(),
  }),
]);
export type StateChange = z.infer<typeof stateChangeSchema>;

export const stateChangeRpc = definePackedRpc({
  name: "review.state-change",
  input: z.object({ ...targetFields, change: stateChangeSchema }),
  output: reviewStateSchema,
});

const agentChoiceSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  status: z.string(),
});
export type AgentChoice = z.infer<typeof agentChoiceSchema>;

/** The workspace's agents a review can go to, most recently used first. */
export const agentsRpc = defineRpc({
  name: "review.agents",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ agents: z.array(agentChoiceSchema) }),
});

const reviewerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), id: z.string() }),
  /** An agent to start in the workspace, with the review as its first message. */
  z.object({
    kind: z.literal("new"),
    workspaceId: z.string(),
    /** `provider/model`. */
    model: z.string(),
    modeId: z.string().nullable(),
    thinkingOptionId: z.string().nullable(),
  }),
]);
export type Reviewer = z.infer<typeof reviewerSchema>;

/** Sends the comments as one review attachment and drops them once the agent has them. */
export const submitRpc = defineRpc({
  name: "review.submit",
  input: z.object({
    ...targetFields,
    baseRef: z.string(),
    /** Null when every comment is a suggested edit, which needs no agent. */
    reviewer: reviewerSchema.nullable(),
    message: z.string(),
    commentIds: z.array(z.string()).min(1),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("sent"), state: reviewStateSchema }),
    failedSchema,
  ]),
});
