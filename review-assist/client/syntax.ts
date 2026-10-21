import { HIGHLIGHT_STYLES, type LineTokens } from "../shared/protocol";
import type { SideLine } from "../shared/sides";
import type { SyntaxPalette } from "./monaco/theme";

export interface FileSyntax {
  readonly old: LineTokens;
  readonly new: LineTokens;
}

export interface ColoredText {
  readonly text: string;
  readonly color: string | null;
}

/** By the line's number in the new file where it has one, so a line both files share reads the same. */
export function lineTokens(syntax: FileSyntax | null, palette: SyntaxPalette | null, line: SideLine): ColoredText[] | null {
  if (syntax == null || palette == null) return null;
  const encoded =
    line.newNumber != null ? syntax.new[line.newNumber - 1] : line.oldNumber != null ? syntax.old[line.oldNumber - 1] : null;
  if (encoded == null) return null;
  const tokens: ColoredText[] = [];
  let at = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    const style = HIGHLIGHT_STYLES[encoded[i + 1]];
    tokens.push({ text: line.text.slice(at, at + encoded[i]), color: style == null ? null : (palette[style] ?? null) });
    at += encoded[i];
  }
  if (at < line.text.length) tokens.push({ text: line.text.slice(at), color: null });
  return tokens;
}
