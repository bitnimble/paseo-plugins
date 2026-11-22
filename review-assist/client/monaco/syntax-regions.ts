import type { SyntaxChange, SyntaxDiff } from "../../shared/protocol";
import type { ChangeRun } from "../../shared/sides";
import type { MonacoRange } from "./api";

export interface InnerChange {
  readonly original: MonacoRange;
  readonly modified: MonacoRange;
}

/** Lines numbered as Monaco numbers them, from 1, each `[start, end)`. */
export interface SyntaxRegion {
  readonly original: readonly [number, number];
  readonly modified: readonly [number, number];
  readonly inner: readonly InnerChange[];
}

type Lines = readonly [original: number, modified: number];

/**
 * Git's changed lines with difftastic's changed tokens inside them, cut where Monaco's side-by-side
 * view couldn't otherwise put a line difftastic paired beside its partner.
 */
export function syntaxRegions(
  changes: readonly ChangeRun[],
  syntax: SyntaxDiff,
  originalLines: readonly string[],
  modifiedLines: readonly string[],
): SyntaxRegion[] {
  return changes.flatMap((run) => runRegions(run, syntax, originalLines, modifiedLines));
}

function runRegions(
  run: ChangeRun,
  syntax: SyntaxDiff,
  originalLines: readonly string[],
  modifiedLines: readonly string[],
): SyntaxRegion[] {
  const end: Lines = [run.original[1] + 1, run.modified[1] + 1];
  let start: Lines = [run.original[0] + 1, run.modified[0] + 1];
  if (start[0] === end[0] || start[1] === end[1]) return [region(start, end, [])];
  const regions: SyntaxRegion[] = [];
  let inner: InnerChange[] = [];
  // Monaco's `computeRangeAlignment` state, mirrored.
  let aligned = start;
  let first = true;
  let originalLine = start[0];
  let modifiedLine = start[1];

  const emit = (original: number, modified: number) => {
    if (original < aligned[0] || modified < aligned[1]) return;
    if (first) first = false;
    else if (original === aligned[0] || modified === aligned[1]) return;
    aligned = [original, modified];
  };
  const add = (change: InnerChange) => {
    const { original, modified } = asNormalized(change, originalLines, modifiedLines);
    inner.push({ original, modified });
    if (original.startColumn > 1 && modified.startColumn > 1) emit(original.startLineNumber, modified.startLineNumber);
    if (original.endColumn < lineEnd(originalLines, original.endLineNumber)) emit(original.endLineNumber, modified.endLineNumber);
  };
  const startAt = (lines: Lines) => {
    start = aligned = lines;
    inner = [];
    first = true;
    add({ original: point(lines[0]), modified: point(lines[1]) });
  };
  const addUnpaired = (originalTo: number, modifiedTo: number) => {
    for (; originalLine < originalTo; originalLine++) {
      for (const change of syntax.oldChanges[originalLine - 1] ?? []) {
        add({ original: span(originalLine, change), modified: point(aligned[1]) });
      }
    }
    for (; modifiedLine < modifiedTo; modifiedLine++) {
      for (const change of syntax.newChanges[modifiedLine - 1] ?? []) {
        add({ original: point(aligned[0]), modified: span(modifiedLine, change) });
      }
    }
  };

  startAt(start);
  for (const [oldIndex, newIndex] of syntax.aligned) {
    if (oldIndex == null || newIndex == null) continue;
    const original = oldIndex + 1;
    const modified = newIndex + 1;
    if (original < originalLine || original >= end[0] || modified < modifiedLine || modified >= end[1]) continue;
    addUnpaired(original, modified);
    if (original !== start[0] || modified !== start[1]) {
      add({ original: point(original), modified: point(modified) });
      if (aligned[0] !== original || aligned[1] !== modified) {
        inner.pop();
        regions.push(region(start, [original, modified], inner));
        startAt([original, modified]);
      }
    }
    for (const change of syntax.oldChanges[oldIndex] ?? []) add({ original: span(original, change), modified: point(modified) });
    for (const change of syntax.newChanges[newIndex] ?? []) add({ original: point(original), modified: span(modified, change) });
    originalLine = original + 1;
    modifiedLine = modified + 1;
  }
  addUnpaired(end[0], end[1]);
  regions.push(region(start, end, inner));
  return regions;
}

/** Monaco draws a region with one side empty as whole lines, without inner changes. */
function region(start: Lines, end: Lines, inner: readonly InnerChange[]): SyntaxRegion {
  const oneSided = start[0] === end[0] || start[1] === end[1];
  return { original: [start[0], end[0]], modified: [start[1], end[1]], inner: oneSided ? [] : inner };
}

/** As Monaco's `normalizeRangeMapping` rewrites it before aligning: whole lines stretched over their line breaks. */
function asNormalized(
  { original, modified }: InnerChange,
  originalLines: readonly string[],
  modifiedLines: readonly string[],
): InnerChange {
  const wholeLines =
    original.startColumn === 1 &&
    modified.startColumn === 1 &&
    (original.endColumn !== 1 || modified.endColumn !== 1) &&
    original.endColumn === lineEnd(originalLines, original.endLineNumber) &&
    modified.endColumn === lineEnd(modifiedLines, modified.endLineNumber) &&
    original.endLineNumber < originalLines.length &&
    modified.endLineNumber < modifiedLines.length;
  if (!wholeLines) return { original, modified };
  const stretched = (range: MonacoRange): MonacoRange => ({ ...range, endLineNumber: range.endLineNumber + 1, endColumn: 1 });
  return { original: stretched(original), modified: stretched(modified) };
}

/** The column past a line's last character; Monaco's lines hold no line ending. */
function lineEnd(lines: readonly string[], line: number): number {
  return (lines[line - 1] ?? "").replace(/\r$/, "").length + 1;
}

function span(line: number, { start, end }: SyntaxChange): MonacoRange {
  return { startLineNumber: line, startColumn: start + 1, endLineNumber: line, endColumn: end + 1 };
}

function point(line: number): MonacoRange {
  return { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 };
}
