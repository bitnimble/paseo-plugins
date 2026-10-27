import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const reviewSettings = defineSettings({
  id: "review",
  scope: "host",
  version: 1,
  schema: z.object({
    /** `provider/model`; empty is "Automatic", which `automaticChoice` resolves. */
    model: z.string().default(""),
    layout: z.enum(["unified", "split"]).default("unified"),
    wrapLines: z.boolean().default(false),
    hideWhitespace: z.boolean().default(false),
    fileList: z.enum(["flat", "tree"]).default("flat"),
    paneWidth: z.number().int().default(300),
    showPane: z.boolean().default(true),
  }),
});

export type ReviewSettings = z.output<typeof reviewSettings.schema>;
export type ViewOptions = Pick<
  ReviewSettings,
  "layout" | "wrapLines" | "hideWhitespace" | "fileList" | "paneWidth" | "showPane"
>;
