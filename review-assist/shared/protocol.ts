import type { HighlightStyle } from "@getpaseo/highlight";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { type FileFacts, NO_FACTS } from "./diff";
import { guideSectionSchema } from "./guide";

const diffModeSchema =z.discriminatedUnion("kind", [
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

const diffBaseSchema = z.object({ label: z.string(), sha: z.string() });
export type DiffBase = z.infer<typeof diffBaseSchema>;

const target = { directory: z.string(), mode: diffModeSchema };

const fileFactsSchema = z.object({
  generated: z.record(z.string(), z.boolean()),
  sizes: z.record(z.string(), z.object({ before: z.number().int(), after: z.number().int() })),
}) satisfies z.ZodType<FileFacts>;

export const diffRpc = defineRpc({
  name: "review.diff",
  input: z.object(target),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ready"),
      raw: z.string(),
      hash: z.string(),
      base: diffBaseSchema,
      root: z.string(),
      tree: z.string(),
      facts: fileFactsSchema,
    }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ]),
});

/** `branches` holds local and remote-tracking branches, most recently committed first. */
export const branchesRpc = defineRpc({
  name: "review.branches",
  input: z.object({ directory: z.string() }),
  output: z.object({ defaultBranch: z.string().nullable(), branches: z.array(z.string()) }),
});

/** `tree` null reads from disk, inside the repository or wherever a language server pointed. */
export const fileRpc = defineRpc({
  name: "review.file",
  input: z.object({ root: z.string(), tree: z.string().nullable(), path: z.string() }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ready"), text: z.string() }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ]),
});

const blobPreviewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("image"), uri: z.string(), bytes: z.number().int() }),
  /** Text git was told not to diff, as with the `-diff` attribute. */
  z.object({ status: z.literal("text") }),
  z.object({ status: z.literal("binary") }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);
export type BlobPreview = z.infer<typeof blobPreviewSchema>;

/** One side of a file git called binary. `blob` is read when `tree` is gone. */
export const blobRpc = defineRpc({
  name: "review.blob",
  input: z.object({ root: z.string(), tree: z.string(), path: z.string(), blob: z.string().nullable() }),
  output: blobPreviewSchema,
});

export const LSP_METHODS = ["textDocument/definition", "textDocument/references", "textDocument/hover"] as const;
export type LspMethod = (typeof LSP_METHODS)[number];

/** `params` omits `textDocument`; the daemon fills it in from `path`. */
export const lspRpc = defineRpc({
  name: "review.lsp",
  input: z.object({
    root: z.string(),
    tree: z.string().nullable(),
    path: z.string(),
    method: z.enum(LSP_METHODS),
    params: z.record(z.string(), z.unknown()),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), result: z.unknown() }),
    z.object({ status: z.literal("unsupported") }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ]),
});

export const leaseRpc = defineRpc({
  name: "review.lease",
  input: z.object({ root: z.string(), leaseId: z.string(), action: z.enum(["hold", "release"]) }),
  output: z.object({}),
});

const trustSchema = z.enum(["undecided", "trusted", "restricted"]);
export type Trust = z.infer<typeof trustSchema>;

export const trustRpc = defineRpc({
  name: "review.trust",
  input: z.object({ directory: z.string() }),
  output: z.object({ trust: trustSchema }),
});

/** Untrusting stops the workspace's language servers. */
export const setTrustRpc = defineRpc({
  name: "review.trust.set",
  input: z.object({ directory: z.string(), trusted: z.boolean() }),
  output: z.object({ trust: trustSchema }),
});

export const HIGHLIGHT_STYLES = [
  "keyword",
  "comment",
  "string",
  "number",
  "literal",
  "function",
  "definition",
  "class",
  "type",
  "tag",
  "attribute",
  "property",
  "variable",
  "operator",
  "punctuation",
  "regexp",
  "escape",
  "meta",
  "heading",
  "link",
] as const satisfies readonly HighlightStyle[];

/** Per line, `[length, style]` pairs; the style indexes `HIGHLIGHT_STYLES`, or is -1 for plain text. */
const lineTokensSchema = z.array(z.array(z.number().int()));
export type LineTokens = z.infer<typeof lineTokensSchema>;

export const highlightRpc = defineRpc({
  name: "review.highlight",
  input: z.object({
    root: z.string(),
    tree: z.string(),
    base: z.string(),
    path: z.string().nullable(),
    oldPath: z.string().nullable(),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ready"), old: lineTokensSchema, new: lineTokensSchema }),
    z.object({ status: z.literal("unsupported") }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ]),
});

const colorSchemeSchema =z.enum(["dark", "light"]);

export const paletteRpc = defineRpc({
  name: "review.palette",
  input: z.object({ scheme: colorSchemeSchema }),
  output: z.object({ colors: z.record(z.string(), z.string()) }),
});

export const MONACO_ASSETS = ["script", "css", "worker"] as const;
export type MonacoAsset = (typeof MONACO_ASSETS)[number];

/** Read in pieces from `offset` until `total`, so no single message carries megabytes. */
export const monacoRpc = defineRpc({
  name: "review.monaco",
  input: z.object({ asset: z.enum(MONACO_ASSETS), offset: z.number().int().nonnegative() }),
  output: z.object({ text: z.string(), total: z.number().int() }),
});

const jobSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running"), agentId: z.string().nullable(), startedAt: z.string() }),
  z.object({ status: z.literal("failed"), agentId: z.string().nullable(), error: z.string() }),
]);
export type GuideJob = z.infer<typeof jobSchema>;

export const guideRecordSchema = z.object({
  diffHash: z.string(),
  raw: z.string(),
  base: diffBaseSchema,
  root: z.string(),
  tree: z.string(),
  facts: fileFactsSchema.default(NO_FACTS),
  sections: z.array(guideSectionSchema).min(1),
  model: z.string(),
  createdAt: z.string(),
});
export type GuideRecord = z.infer<typeof guideRecordSchema>;

export const guideRpc = defineRpc({
  name: "review.guide",
  input: z.object(target),
  output: z.object({ job: jobSchema.nullable(), guide: guideRecordSchema.nullable() }),
});

export const generateRpc = defineRpc({
  name: "review.generate",
  input: z.object({ ...target, workspaceId: z.string() }),
  output: z.object({ job: jobSchema }),
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
  createdAt: z.string(),
});
export type DraftComment = z.infer<typeof draftCommentSchema>;

export const reviewStateSchema = z.object({
  viewed: z.array(viewedMarkSchema),
  comments: z.array(draftCommentSchema),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const stateRpc = defineRpc({
  name: "review.state",
  input: z.object(target),
  output: reviewStateSchema,
});

export const viewedRpc = defineRpc({
  name: "review.viewed",
  input: z.object({ ...target, ...viewedMarkSchema.shape, viewed: z.boolean() }),
  output: reviewStateSchema,
});

export const commentRpc = defineRpc({
  name: "review.comment",
  input: z.object({
    ...target,
    change: z.discriminatedUnion("action", [
      z.object({ action: z.literal("save"), comment: draftCommentSchema }),
      z.object({ action: z.literal("delete"), id: z.string() }),
    ]),
  }),
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

/** Sends the comments as one review attachment and drops them once the agent has them. */
export const submitRpc = defineRpc({
  name: "review.submit",
  input: z.object({
    ...target,
    baseRef: z.string(),
    agentId: z.string(),
    message: z.string(),
    commentIds: z.array(z.string()).min(1),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("sent"), state: reviewStateSchema }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ]),
});
