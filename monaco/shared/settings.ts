import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_COMMAND = "openvscode-server";

export const serverSettingsSchema = z.object({
  command: z.string().default(DEFAULT_COMMAND),
  extraArgs: z.string().default(""),
  bindHost: z.string().default("127.0.0.1"),
  /** Set when the app is not on the daemon machine and reaches the server through a proxy or tunnel. */
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
