import { highlightCode, isLanguageSupported } from "@getpaseo/highlight";
import { MAX_HIGHLIGHTED_CHARS, encodeTokens } from "../kit/server/highlight";
import type { LineTokens } from "../kit/shared/protocol";
import { readBlob } from "./git";
import type { TreeFiles } from "./trees";

export type HighlightOutcome =
  | { readonly status: "ready"; readonly old: LineTokens; readonly new: LineTokens }
  | { readonly status: "unsupported" };

/** Highlights whole files, not diff lines, so strings and comments spanning lines color correctly. */
export async function highlightSides(
  trees: TreeFiles,
  input: { root: string; tree: string; base: string; path: string | null; oldPath: string | null },
): Promise<HighlightOutcome> {
  const { root, tree, base, path, oldPath } = input;
  if (!isLanguageSupported(path ?? oldPath ?? "")) return { status: "unsupported" };
  const [newText, oldText] = await Promise.all([
    path == null ? "" : trees.read(root, tree, path),
    oldPath == null ? "" : readBlob(root, base, oldPath),
  ]);
  if (newText.length + oldText.length > MAX_HIGHLIGHTED_CHARS) return { status: "unsupported" };
  return {
    status: "ready",
    old: oldPath == null ? [] : encodeTokens(highlightCode(oldText, oldPath)),
    new: path == null ? [] : encodeTokens(highlightCode(newText, path)),
  };
}
