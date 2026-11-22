import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const reviewSettings = defineSettings({
  id: "review",
  scope: "host",
  version: 1,
  schema: z.object({
    /** `provider/model`; empty is "Automatic", which `automaticChoice` resolves. */
    model: z.string().default(""),
    /** `provider/model`; empty is none. */
    backupModel: z.string().default(""),
    /** Takes effect only while `difft` is available, so a host that installs it later gets it on. */
    difftastic: z.boolean().default(true),
    sectionLines: z.number().int().positive().default(500),
    promptContextLines: z.number().int().min(0).default(5),
    /** Show the model the signatures of the declarations each hunk sits in. */
    promptScope: z.boolean().default(true),
    layout: z.enum(["unified", "split"]).default("unified"),
    wrapLines: z.boolean().default(false),
    hideWhitespace: z.boolean().default(false),
    fileList: z.enum(["flat", "tree"]).default("flat"),
    paneWidth: z.number().int().default(300),
    showPane: z.boolean().default(true),
    sectionsNarrow: z.enum(["paged", "continuous"]).default("continuous"),
    sectionsWide: z.enum(["paged", "continuous"]).default("paged"),
  }),
});

export type ReviewSettings = z.output<typeof reviewSettings.schema>;
export type SectionsLayout = ReviewSettings["sectionsWide"];
/** As shown: `layout` and `sections` resolved for the panel's width. */
export type ViewOptions = Pick<
  ReviewSettings,
  "layout" | "wrapLines" | "hideWhitespace" | "difftastic" | "fileList" | "paneWidth" | "showPane"
> & { readonly sections: SectionsLayout };
