import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { serverSettingsSchema } from "./settings";

/**
 * One editor server serves every workspace, each as a `?folder=`. A lease per open panel keeps it
 * alive; the last release stops it.
 */
export const sessionRpc = defineRpc({
  name: "editor.session",
  input: z.object({
    workspaceId: z.string(),
    leaseId: z.string(),
    action: z.enum(["hold", "release"]),
    settings: serverSettingsSchema.optional(),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ready"), url: z.string() }),
    z.object({ status: z.literal("released") }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ]),
});
