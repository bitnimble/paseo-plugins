import { type DiffFile, type DiffHunk, type DiffLine, isChange } from "./diff";
import { hideWhitespaceChanges } from "./display";
import type { DiffChunk, FileBlock } from "./guide";

/** A line as one side of a block shows it, numbered in the diff's real old and new files. */
export interface SideLine {
  readonly text: string;
  /** Null for a line the diff adds. */
  readonly oldNumber: number | null;
  /** Null for a line the diff removes. */
  readonly newNumber: number | null;
}

export interface Side {
  readonly text: string;
  readonly lines: readonly SideLine[];
}

export interface BlockSides {
  readonly original: Side;
  readonly modified: Side;
}

export interface ShownHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

interface Line extends SideLine {
  readonly eol: boolean;
}

export const CONTEXT_LINES = 3;

/**
 * The file before and after the block's own changes, given `newText`, the file as the whole diff
 * leaves it. `ignoreWhitespace` shows whitespace-only edits as unchanged, as `git diff -w` would.
 */
export function blockSides(block: FileBlock, newText: string, ignoreWhitespace: boolean): BlockSides {
  const unchanged = splitLines(newText);
  const original: Line[] = [];
  const modified: Line[] = [];
  let next = 0;
  let oldShift = 0;
  const keepUnchanged = (end: number) => {
    for (; next < end; next++) {
      const line = { ...unchanged[next], oldNumber: next + 1 + oldShift, newNumber: next + 1 };
      original.push(line);
      modified.push(line);
    }
  };
  for (const hunk of block.file.hunks) {
    const oldCount = hunk.lines.filter((line) => line.kind !== "add").length;
    const newCount = hunk.lines.filter((line) => line.kind !== "del").length;
    // An empty new side's start names the line before the hunk.
    keepUnchanged(newCount === 0 ? hunk.newStart : hunk.newStart - 1);
    for (const shown of shownLines(block, hunk, ignoreWhitespace)) {
      const line = { ...shown, eol: shown.noNewlineMarker == null };
      if (shown.kind !== "add") original.push(line);
      if (shown.kind !== "del") modified.push(line);
    }
    next += newCount;
    oldShift += oldCount - newCount;
  }
  keepUnchanged(unchanged.length);
  return { original: side(original), modified: side(modified) };
}

/** The block's own changes with a few lines of context, cut into hunks the way git would. */
export function blockHunks(block: FileBlock, ignoreWhitespace: boolean): ShownHunk[] {
  return block.file.hunks.flatMap((hunk) => {
    const lines = shownLines(block, hunk, ignoreWhitespace);
    const ranges: [number, number][] = [];
    lines.forEach((line, i) => {
      if (!isChange(line)) return;
      const start = Math.max(0, i - CONTEXT_LINES);
      const end = Math.min(lines.length, i + CONTEXT_LINES + 1);
      const last = ranges[ranges.length - 1];
      if (last != null && start <= last[1]) last[1] = end;
      else ranges.push([start, end]);
    });
    return ranges.map(([start, end]) => {
      const shown = lines.slice(start, end);
      return { header: rangeHeader(shown), lines: shown };
    });
  });
}

export function rangeHeader(lines: readonly Omit<SideLine, "text">[]): string {
  const olds = lines.flatMap((line) => (line.oldNumber == null ? [] : [line.oldNumber]));
  const news = lines.flatMap((line) => (line.newNumber == null ? [] : [line.newNumber]));
  return `@@ -${olds[0] ?? 0},${olds.length} +${news[0] ?? 0},${news.length} @@`;
}

/** The new file from the old one, for when the new side's objects are gone. */
export function applyHunks(oldText: string, file: DiffFile): string {
  const unchanged = splitLines(oldText);
  const out: Line[] = [];
  let next = 0;
  for (const hunk of file.hunks) {
    const oldCount = hunk.lines.filter((line) => line.kind !== "add").length;
    const first = oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    while (next < first) out.push(unchanged[next++]);
    for (const line of hunk.lines) {
      if (line.kind !== "del") out.push({ ...line, eol: line.noNewlineMarker == null });
    }
    next = first + oldCount;
  }
  while (next < unchanged.length) out.push(unchanged[next++]);
  return side(out).text;
}

function shownLines(block: FileBlock, hunk: DiffHunk, ignoreWhitespace: boolean): DiffLine[] {
  const own = indexesIn(block.chunks, hunk);
  const later = indexesIn(block.later, hunk);
  const lines = hunk.lines.flatMap((line, i): DiffLine[] => {
    if (line.kind === "context" || own.has(i)) return [line];
    // An earlier addition and a later removal are on both sides; the other two are on neither.
    return (line.kind === "add") !== later.has(i) ? [{ ...line, kind: "context" }] : [];
  });
  return ignoreWhitespace ? hideWhitespaceChanges(lines) : lines;
}

function indexesIn(chunks: readonly DiffChunk[], hunk: DiffHunk): Set<number> {
  const indexes = new Set<number>();
  for (const chunk of chunks) {
    if (chunk.hunk !== hunk) continue;
    for (let i = chunk.start; i < chunk.end; i++) indexes.add(i);
  }
  return indexes;
}

function side(lines: readonly Line[]): Side {
  const last = lines[lines.length - 1];
  const text = lines.map((line) => line.text).join("\n") + (last?.eol === true ? "\n" : "");
  return { text, lines: lines.map(({ text, oldNumber, newNumber }) => ({ text, oldNumber, newNumber })) };
}

function splitLines(text: string): Line[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const eol = text.endsWith("\n");
  if (eol) parts.pop();
  return parts.map((part, i) => ({ text: part, eol: eol || i < parts.length - 1, oldNumber: null, newNumber: null }));
}
