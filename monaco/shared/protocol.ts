import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const listFilesRpc = defineRpc({
  name: "editor.list_files",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    files: z.array(z.string()),
    truncated: z.boolean(),
  }),
});

export const readFileRpc = defineRpc({
  name: "editor.read_file",
  input: z.object({ workspaceId: z.string(), path: z.string() }),
  output: z.object({ text: z.string() }),
});

export const writeFileRpc = defineRpc({
  name: "editor.write_file",
  input: z.object({ workspaceId: z.string(), path: z.string(), text: z.string() }),
  output: z.object({ written: z.literal(true) }),
});

export const leaseRpc = defineRpc({
  name: "editor.lease",
  input: z.object({
    workspaceId: z.string(),
    leaseId: z.string(),
    action: z.enum(["hold", "release"]),
  }),
  output: z.object({ leases: z.number() }),
});

export const LSP_METHODS = [
  "textDocument/definition",
  "textDocument/references",
  "textDocument/hover",
  "textDocument/completion",
] as const;

export type LspMethod = (typeof LSP_METHODS)[number];

/** `params` omits `textDocument`; the daemon fills it in from `path`. */
export const lspRpc = defineRpc({
  name: "editor.lsp",
  input: z.object({
    workspaceId: z.string(),
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

export const syncRpc = defineRpc({
  name: "editor.sync",
  input: z.object({
    workspaceId: z.string(),
    path: z.string(),
    kind: z.enum(["change", "save", "close"]),
    text: z.string(),
  }),
  output: z.object({ synced: z.boolean() }),
});
