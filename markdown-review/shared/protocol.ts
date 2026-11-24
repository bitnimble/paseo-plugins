import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Where a document's comments are kept: `root` is its repository's top level, or its directory outside one. */
export const documentRpc = defineRpc({
  name: "markdown-review.document",
  input: z.object({ path: z.string() }),
  output: z.object({ root: z.string(), path: z.string() }),
});
