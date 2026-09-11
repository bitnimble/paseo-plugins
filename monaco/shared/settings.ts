import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_COMMAND = "openvscode-server";

export const serverSettingsSchema = z.object({
  command: z.string().default(DEFAULT_COMMAND),
  extraArgs: z.string().default(""),
  bindHost: z.string().default("127.0.0.1"),
  /** 0 picks a free port. Pin it for a remote daemon: a tunnel or proxy needs a stable number. */
  port: z.number().int().min(0).max(65_535).default(0),
  /** Origin the app should load, used verbatim. Empty means the bind address and port. */
  publicUrl: z.string().default(""),
});

export type ServerSettings = z.infer<typeof serverSettingsSchema>;

export const editorSettings = defineSettings({
  id: "editor",
  scope: "host",
  version: 2,
  schema: serverSettingsSchema,
  migrate: () => ({}),
});
