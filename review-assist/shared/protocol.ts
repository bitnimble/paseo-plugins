import type { HighlightStyle } from "@getpaseo/highlight";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { type FileFacts, NO_FACTS } from "./diff";
import type { Failed } from "./errors";
import { guideSectionSchema } from "./guide";

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

const diffBaseSchema = z.object({ label: z.string(), sha: z.string() });
export type DiffBase = z.infer<typeof diffBaseSchema>;

const target = { directory: z.string(), mode: diffModeSchema };

const failedSchema = z.object({ status: z.literal("failed"), error: z.string() }) satisfies z.ZodType<Failed>;

const deflatedSchema = z.object({ deflated: z.string() }).strict();
/** An output's JSON, raw-deflated and base64-encoded. */
export type Deflated = z.infer<typeof deflatedSchema>;

export function isDeflated(output: unknown): output is Deflated {
  return deflatedSchema.safeParse(output).success;
}

/** Large outputs arrive `Deflated`; read them with `usePackedRpc`. */
function definePackedRpc<Input extends z.ZodType, Output extends z.ZodType>(definition: {
  name: string;
  input: Input;
  output: Output;
}) {
  return defineRpc({ ...definition, output: z.union([deflatedSchema, definition.output]) });
}

const fileFactsSchema = z.object({
  generated: z.record(z.string(), z.boolean()),
  sizes: z.record(z.string(), z.object({ before: z.number().int(), after: z.number().int() })),
  lfs: z.array(z.string()).readonly().default([]),
}) satisfies z.ZodType<FileFacts>;

export const diffRpc = definePackedRpc({
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
    failedSchema,
  ]),
});

/** `branches` holds local and remote-tracking branches, most recently committed first. */
export const branchesRpc = defineRpc({
  name: "review.branches",
  input: z.object({ directory: z.string() }),
  output: z.object({ defaultBranch: z.string().nullable(), branches: z.array(z.string()) }),
});

/** `tree` null reads from disk, inside the repository or wherever a language server pointed. */
export const fileRpc = definePackedRpc({
  name: "review.file",
  input: z.object({ root: z.string(), tree: z.string().nullable(), path: z.string() }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ready"), text: z.string() }),
    failedSchema,
  ]),
});

const blobPreviewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("image"), uri: z.string(), bytes: z.number().int() }),
  /** Text git was told not to diff, as with the `-diff` attribute. */
  z.object({ status: z.literal("text") }),
  z.object({ status: z.literal("binary") }),
  failedSchema,
]);
export type BlobPreview = z.infer<typeof blobPreviewSchema>;

/**
 * One side of a file git called binary. `blob` is read when `tree` is gone. `lfs` reads the content an
 * LFS pointer names, downloading it if it isn't cached.
 */
export const blobRpc = defineRpc({
  name: "review.blob",
  input: z.object({
    root: z.string(),
    tree: z.string(),
    path: z.string(),
    blob: z.string().nullable(),
    lfs: z.boolean().default(false),
  }),
  output: blobPreviewSchema,
});

export const LSP_METHODS = ["textDocument/definition", "textDocument/references", "textDocument/hover"] as const;
export type LspMethod = (typeof LSP_METHODS)[number];

/** `params` omits `textDocument`; the daemon fills it in from `path`. */
export const lspRpc = definePackedRpc({
  name: "review.lsp",
  input: z.object({
    projectId: z.string(),
    root: z.string(),
    tree: z.string().nullable(),
    path: z.string(),
    method: z.enum(LSP_METHODS),
    params: z.record(z.string(), z.unknown()),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), result: z.unknown() }),
    z.object({ status: z.literal("unsupported") }),
    failedSchema,
  ]),
});

export const leaseRpc = defineRpc({
  name: "review.lease",
  input: z.object({ projectId: z.string(), root: z.string(), leaseId: z.string(), action: z.enum(["hold", "release"]) }),
  output: z.object({}),
});

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

const trustSchema = z.enum(["undecided", "trusted", "restricted"]);
export type Trust = z.infer<typeof trustSchema>;

export const trustRpc = defineRpc({
  name: "review.trust",
  input: z.object({ projectId: z.string() }),
  output: z.object({ trust: trustSchema }),
});

/** Untrusting stops the project's language servers. */
export const setTrustRpc = defineRpc({
  name: "review.trust.set",
  input: z.object({ projectId: z.string(), trusted: z.boolean() }),
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

export const highlightRpc = definePackedRpc({
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
    failedSchema,
  ]),
});

const colorSchemeSchema = z.enum(["dark", "light"]);

export const paletteRpc = defineRpc({
  name: "review.palette",
  input: z.object({ scheme: colorSchemeSchema }),
  output: z.object({ colors: z.record(z.string(), z.string()) }),
});

const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

const mermaidPaletteSchema = z.object({
  dark: z.boolean(),
  background: hexColorSchema,
  surface: hexColorSchema,
  foreground: hexColorSchema,
  muted: hexColorSchema,
  border: hexColorSchema,
  added: hexColorSchema,
  removed: hexColorSchema,
  changed: hexColorSchema,
});
export type MermaidPalette = z.infer<typeof mermaidPaletteSchema>;

const MAX_MERMAID_CHARS = 200_000;

/** How many links from a change a diagram's diff keeps, until its reader asks for more or fewer. */
export const MERMAID_DEFAULT_DISTANCE = 1;
export const MERMAID_MAX_DISTANCE = 9;

const mermaidOutcomeSchema = z.discriminatedUnion("status", [
  /** `width` and `height` in points; a PNG has twice the pixels. `truncated` when nodes were left out. */
  z.object({
    status: z.literal("ready"),
    uri: z.string(),
    width: z.number(),
    height: z.number(),
    truncated: z.boolean(),
  }),
  /** Why the diagram has no visual diff, such as a kind it does not draw or a parse error. */
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type MermaidOutcome = z.infer<typeof mermaidOutcomeSchema>;

const mermaidDrawSchema = z.object({
  before: z.string().max(MAX_MERMAID_CHARS),
  after: z.string().max(MAX_MERMAID_CHARS),
  format: z.enum(["svg", "png"]),
  palette: mermaidPaletteSchema,
  /** Links from a change that nodes are kept within. */
  distance: z.number().int().min(1).max(MERMAID_MAX_DISTANCE),
});
export type MermaidDraw = z.infer<typeof mermaidDrawSchema>;

/** Draws `before` laid over `after`; SVG for the web, PNG where images can't be SVG. */
export const mermaidRpc = definePackedRpc({
  name: "review.mermaid",
  input: mermaidDrawSchema,
  output: mermaidOutcomeSchema,
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

export const MONACO_ASSETS = ["script", "css", "worker"] as const;
export type MonacoAsset = (typeof MONACO_ASSETS)[number];

/** Read in pieces from `offset` until `total`, so no single message carries megabytes. */
export const monacoRpc = definePackedRpc({
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

export const guideRpc = definePackedRpc({
  name: "review.guide",
  input: z.object(target),
  output: z.object({ job: jobSchema.nullable(), guide: guideRecordSchema.nullable() }),
});

export const guideJobRpc = defineRpc({
  name: "review.guide-job",
  input: z.object(target),
  output: z.object({ job: jobSchema.nullable() }),
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
  input: z.object(target),
  output: reviewStateSchema,
});

const stateChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("viewed"), mark: viewedMarkSchema, viewed: z.boolean() }),
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
  input: z.object({ ...target, change: stateChangeSchema }),
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
    ...target,
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
