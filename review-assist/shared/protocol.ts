import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { type FileFacts, NO_FACTS } from "../kit/shared/diff";
import {
  definePackedRpc,
  diffModeSchema,
  failedSchema,
  lineTokensSchema,
  targetFields,
} from "../kit/shared/protocol";
import { guideSectionSchema } from "./guide";

const diffBaseSchema = z.object({ label: z.string(), sha: z.string() });
export type DiffBase = z.infer<typeof diffBaseSchema>;

const fileFactsSchema = z.object({
  generated: z.record(z.string(), z.boolean()),
  sizes: z.record(z.string(), z.object({ before: z.number().int(), after: z.number().int() })),
  lfs: z.array(z.string()).readonly().default([]),
}) satisfies z.ZodType<FileFacts>;

export const diffRpc = definePackedRpc({
  name: "review.diff",
  input: z.object(targetFields),
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

const difftasticStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), version: z.string() }),
  z.object({ status: z.literal("missing"), reason: z.string() }),
]);
export type DifftasticStatus = z.infer<typeof difftasticStatusSchema>;

/** `recheck` probes for `difft` again instead of answering from the last probe. */
export const difftasticStatusRpc = defineRpc({
  name: "review.difftastic.status",
  input: z.object({ recheck: z.boolean() }),
  output: difftasticStatusSchema,
});

const syntaxChangeSchema = z.object({ start: z.number().int(), end: z.number().int(), highlight: z.string() });
export type SyntaxChange = z.infer<typeof syntaxChangeSchema>;

const syntaxDiffSchema = z.object({
  /** `Text` when difftastic fell back to a line diff. */
  language: z.string(),
  /** 0-based line numbers of each side shown level with each other; null opposite an added or removed line. */
  aligned: z.array(z.tuple([z.number().int().nullable(), z.number().int().nullable()])),
  /** Changed spans in character columns, by 0-based line. */
  oldChanges: z.record(z.string(), z.array(syntaxChangeSchema)),
  newChanges: z.record(z.string(), z.array(syntaxChangeSchema)),
});
export type SyntaxDiff = z.infer<typeof syntaxDiffSchema>;

/** `path` picks the language; the texts are diffed as given. */
export const syntaxDiffRpc = definePackedRpc({
  name: "review.difftastic.diff",
  input: z.object({ path: z.string(), original: z.string(), modified: z.string() }),
  output: z.discriminatedUnion("status", [z.object({ status: z.literal("ready"), diff: syntaxDiffSchema }), failedSchema]),
});

/** Null until a mode is picked for the workspace on some device. */
export const modeRpc = defineRpc({
  name: "review.mode",
  input: z.object({ directory: z.string() }),
  output: z.object({ mode: diffModeSchema.nullable() }),
});

export const setModeRpc = defineRpc({
  name: "review.mode.set",
  input: z.object({ directory: z.string(), mode: diffModeSchema }),
  output: z.object({ mode: diffModeSchema }),
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

const lspPositionSchema = z.object({ line: z.number().int(), character: z.number().int() });

const peekLocationSchema = z.object({
  /** Relative to the root, or absolute outside it. */
  path: z.string(),
  range: z.object({ start: lspPositionSchema, end: lspPositionSchema }),
  /** The 0-based line `lines` starts at. */
  first: z.number().int(),
  lines: z.array(z.string()),
  tokens: lineTokensSchema.nullable(),
});
export type PeekLocation = z.infer<typeof peekLocationSchema>;

const peekOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), hover: z.string().nullable(), locations: z.array(peekLocationSchema) }),
  z.object({ status: z.literal("unsupported") }),
  failedSchema,
]);
export type PeekOutcome = z.infer<typeof peekOutcomeSchema>;

/** Definition and hover at `position` in `path` as `tree` holds it, with the lines around each definition. */
export const peekRpc = definePackedRpc({
  name: "review.peek",
  input: z.object({
    projectId: z.string(),
    root: z.string(),
    tree: z.string(),
    path: z.string(),
    position: lspPositionSchema,
  }),
  output: peekOutcomeSchema,
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
  input: z.object(targetFields),
  output: z.object({ job: jobSchema.nullable(), guide: guideRecordSchema.nullable() }),
});

export const guideJobRpc = defineRpc({
  name: "review.guide-job",
  input: z.object(targetFields),
  output: z.object({ job: jobSchema.nullable() }),
});

export const generateRpc = defineRpc({
  name: "review.generate",
  input: z.object({ ...targetFields, workspaceId: z.string() }),
  output: z.object({ job: jobSchema }),
});
