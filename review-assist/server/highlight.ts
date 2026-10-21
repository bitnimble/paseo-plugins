import { type HighlightToken, highlightCode, isLanguageSupported, resolveSyntaxColors } from "@getpaseo/highlight";
import { HIGHLIGHT_STYLES, type LineTokens } from "../shared/protocol";
import { readBlob } from "./git";
import type { TreeFiles } from "./trees";

const MAX_HIGHLIGHTED_CHARS = 2_000_000;
const STYLE_INDEX = new Map<string, number>(HIGHLIGHT_STYLES.map((style, index) => [style, index]));

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
    old: oldPath == null ? [] : encode(highlightCode(oldText, oldPath)),
    new: path == null ? [] : encode(highlightCode(newText, path)),
  };
}

export function syntaxPalette(scheme: "dark" | "light"): Record<string, string> {
  // Paseo's default highlight theme; plugins are not told which one the user picked.
  return resolveSyntaxColors("one", scheme);
}

function encode(lines: readonly HighlightToken[][]): LineTokens {
  return lines.map((tokens) =>
    tokens.flatMap((token) => [token.text.length, token.style == null ? -1 : (STYLE_INDEX.get(token.style) ?? -1)]),
  );
}
