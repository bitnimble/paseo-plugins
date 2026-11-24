import { type ColoredText, type SyntaxPalette, coloredTokens } from "../kit/client/syntax-colors";
import type { Span } from "../kit/shared/display";
import type { LineTokens } from "../kit/shared/protocol";
import type { SideLine } from "../kit/shared/sides";

// Skips U+2000-206F, general punctuation such as curly quotes and dashes.
const WORDS = /[\w$À-῿⁰-￿]+/g;
const WORD = /^[\w$À-῿⁰-￿]+$/;

export interface FileSyntax {
  readonly old: LineTokens;
  readonly new: LineTokens;
}

export interface CodePiece extends ColoredText {
  /** Where it starts in the line. */
  readonly start: number;
  /** Within one of the spans. */
  readonly marked: boolean;
  readonly word: boolean;
}

/** By the line's number in the new file where it has one, so a line both files share reads the same. */
export function lineTokens(syntax: FileSyntax | null, palette: SyntaxPalette | null, line: SideLine): ColoredText[] | null {
  if (syntax == null || palette == null) return null;
  const encoded =
    line.newNumber != null ? syntax.new[line.newNumber - 1] : line.oldNumber != null ? syntax.old[line.oldNumber - 1] : null;
  return encoded == null ? null : coloredTokens(encoded, line.text, palette);
}

/** `tokens` cut where each span starts and ends, and around each word when `words`. */
export function codePieces(tokens: readonly ColoredText[], spans: readonly Span[], words: boolean): CodePiece[] {
  const pieces: CodePiece[] = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + token.text.length;
    const cuts = new Set([offset, end]);
    for (const { start, end: stop } of spans) {
      if (start > offset && start < end) cuts.add(start);
      if (stop > offset && stop < end) cuts.add(stop);
    }
    if (words) {
      for (const match of token.text.matchAll(WORDS)) {
        cuts.add(offset + match.index);
        cuts.add(offset + match.index + match[0].length);
      }
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const text = token.text.slice(sorted[i] - offset, sorted[i + 1] - offset);
      if (text === "") continue;
      const marked = spans.some(({ start, end: stop }) => sorted[i] >= start && sorted[i] < stop);
      pieces.push({ text, color: token.color, start: sorted[i], marked, word: words && WORD.test(text) });
    }
    offset = end;
  }
  return pieces;
}

/** The whole word around `at` in `text`, which marks or highlighting may have cut into pieces. */
export function wordAt(text: string, at: number): { start: number; text: string } | null {
  for (const match of text.matchAll(WORDS)) {
    if (match.index <= at && at < match.index + match[0].length) return { start: match.index, text: match[0] };
  }
  return null;
}

export function expandTabs(text: string): string {
  return text.replace(/\t/g, "    ");
}
