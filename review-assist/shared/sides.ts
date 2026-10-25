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
  /** Ends before the change past the limit, leaving out the rest of the file. */
  readonly cut: boolean;
}

export interface ShownHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
  /** Where `lines` sit in the list they were cut from. */
  readonly start?: number;
  readonly end?: number;
}

interface Line extends SideLine {
  readonly eol: boolean;
}

export const CONTEXT_LINES = 3;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";
export const CAPPED_CHANGES = 400;
export const MORE_CHANGES_STEP = 2000;

/**
 * The file before and after the block's own changes, given `newText`, the file as the whole diff
 * leaves it. `ignoreWhitespace` shows whitespace-only edits as unchanged, as `git diff -w` would.
 */
export function blockSides(
  block: FileBlock,
  newText: string,
  ignoreWhitespace: boolean,
  changeLimit = Infinity,
): BlockSides {
  const { lines, cut } = wholeFileLines(block, newText, ignoreWhitespace, changeLimit);
  const sideOf = (dropped: DiffLine["kind"]) =>
    side(lines.flatMap((line) => (line.kind === dropped ? [] : [{ ...line, eol: line.noNewlineMarker == null }])));
  return { original: sideOf("add"), modified: sideOf("del"), cut };
}

/** The whole file as the block shows it: its own changes among every other line, unchanged. */
export function wholeFileLines(
  block: FileBlock,
  newText: string,
  ignoreWhitespace: boolean,
  changeLimit = Infinity,
): { lines: DiffLine[]; cut: boolean } {
  const unchanged = splitLines(newText);
  const lines: DiffLine[] = [];
  let next = 0;
  let oldShift = 0;
  let changes = 0;
  const keepUnchanged = (end: number) => {
    for (; next < end && next < unchanged.length; next++) {
      const { text, eol } = unchanged[next];
      const noNewlineMarker = eol ? null : NO_NEWLINE_MARKER;
      lines.push({ kind: "context", text, oldNumber: next + 1 + oldShift, newNumber: next + 1, noNewlineMarker });
    }
  };
  for (const hunk of block.file.hunks) {
    const oldCount = hunk.lines.filter((line) => line.kind !== "add").length;
    const newCount = hunk.lines.filter((line) => line.kind !== "del").length;
    // An empty new side's start names the line before the hunk.
    keepUnchanged(newCount === 0 ? hunk.newStart : hunk.newStart - 1);
    const taken = takeChanges(shownLines(block, hunk, ignoreWhitespace), changeLimit - changes);
    for (const line of taken.lines) lines.push(line);
    if (taken.cut) return { lines, cut: true };
    changes += taken.changes;
    next += newCount;
    oldShift += oldCount - newCount;
  }
  keepUnchanged(unchanged.length);
  return { lines, cut: false };
}

/** Lines within `context` of a change, or of a range in `shown`, cut into hunks. */
export function hunksOf(
  lines: readonly DiffLine[],
  context: number,
  shown: readonly (readonly [number, number])[] = [],
): ShownHunk[] {
  const ranges: [number, number][] = [];
  const add = (start: number, end: number) => ranges.push([Math.max(0, start), Math.min(lines.length, end)]);
  lines.forEach((line, i) => {
    if (isChange(line)) add(i - context, i + context + 1);
  });
  for (const [start, end] of shown) add(start, end);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last != null && start <= last[1]) last[1] = Math.max(last[1], end);
    else if (start < end) merged.push([start, end]);
  }
  return merged.map(([start, end]) => {
    const hunkLines = lines.slice(start, end);
    return { header: rangeHeader(hunkLines), lines: hunkLines, start, end };
  });
}

export function shownChangeCount(block: FileBlock, ignoreWhitespace: boolean): number {
  return block.file.hunks.reduce((count, hunk) => count + shownLines(block, hunk, ignoreWhitespace).filter(isChange).length, 0);
}

/** The smallest change limit that keeps every line `wanted` picks in view. */
export function changesThrough(
  block: FileBlock,
  ignoreWhitespace: boolean,
  wanted: (line: DiffLine) => boolean,
): number {
  let changes = 0;
  let through = 0;
  for (const hunk of block.file.hunks) {
    const lines = shownLines(block, hunk, ignoreWhitespace);
    for (let i = 0; i < lines.length; i++) {
      if (wanted(lines[i])) {
        // Through the end of its run: a cut inside a run keeps removals and additions in proportion.
        let end = i;
        while (end < lines.length && isChange(lines[end])) end++;
        through = changes + end - i;
      }
      if (isChange(lines[i])) changes++;
    }
  }
  return through;
}

/** The block's own changes with a few lines of context, cut into hunks the way git would. */
export function blockHunks(block: FileBlock, ignoreWhitespace: boolean): ShownHunk[] {
  return block.file.hunks.flatMap((hunk) => hunksOf(shownLines(block, hunk, ignoreWhitespace), CONTEXT_LINES));
}

/**
 * The lines up to `room` changes in. A run of changes the limit falls inside keeps its removals and
 * additions in proportion, so a rewritten block shows old and new lines rather than only the old.
 */
export function takeChanges(
  lines: readonly DiffLine[],
  room: number,
): { lines: readonly DiffLine[]; changes: number; cut: boolean } {
  const taken: DiffLine[] = [];
  let changes = 0;
  for (let i = 0; i < lines.length; ) {
    if (!isChange(lines[i])) {
      taken.push(lines[i++]);
      continue;
    }
    let end = i;
    while (end < lines.length && isChange(lines[end])) end++;
    const run = lines.slice(i, end);
    i = end;
    if (changes + run.length <= room) {
      for (const line of run) taken.push(line);
      changes += run.length;
      continue;
    }
    const left = room - changes;
    const removals = run.filter((line) => line.kind === "del").length;
    const keptRemovals = Math.min(removals, Math.ceil((left * removals) / run.length));
    let removed = 0;
    let added = 0;
    for (const line of run) {
      if (line.kind === "del" ? removed++ < keptRemovals : added++ < left - keptRemovals) taken.push(line);
    }
    return { lines: taken, changes: room, cut: true };
  }
  return { lines: taken, changes, cut: false };
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
