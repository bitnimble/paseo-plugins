import { type HighlightToken, highlightCode, isLanguageSupported, resolveSyntaxColors } from "@getpaseo/highlight";
import { HIGHLIGHT_STYLES, type LineTokens } from "../shared/protocol";

export const MAX_HIGHLIGHTED_CHARS = 2_000_000;
const STYLE_INDEX = new Map<string, number>(HIGHLIGHT_STYLES.map((style, index) => [style, index]));
const FENCE_EXTENSIONS: Readonly<Record<string, string>> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  rust: "rs",
  golang: "go",
  csharp: "cs",
  "c#": "cs",
  "c++": "cpp",
  objc: "m",
  "objective-c": "m",
  elixir: "ex",
  markdown: "md",
  jsonc: "json",
  json5: "json",
};

/** Null for a language the highlighter lacks, or a file too large to highlight. */
export function highlightFile(text: string, path: string): LineTokens | null {
  if (!isLanguageSupported(path) || text.length > MAX_HIGHLIGHTED_CHARS) return null;
  return encodeTokens(highlightCode(text, path));
}

/** A fenced code block's lines, by the fence's language name or extension. */
export function highlightFenced(text: string, language: string | null): LineTokens | null {
  if (language == null) return null;
  const name = language.toLowerCase();
  return highlightFile(text, `code.${FENCE_EXTENSIONS[name] ?? name}`);
}

export function syntaxPalette(scheme: "dark" | "light"): Record<string, string> {
  // Paseo's default highlight theme; plugins are not told which one the user picked.
  return resolveSyntaxColors("one", scheme);
}

export function encodeTokens(lines: readonly HighlightToken[][]): LineTokens {
  return lines.map((tokens) =>
    tokens.flatMap((token) => [token.text.length, token.style == null ? -1 : (STYLE_INDEX.get(token.style) ?? -1)]),
  );
}
