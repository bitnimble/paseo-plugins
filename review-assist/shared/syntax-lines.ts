import type { DiffLine } from "../kit/shared/diff";
import type { Span } from "../kit/shared/display";
import type { SyntaxDiff } from "./protocol";

/** Difftastic's changed tokens on each changed line, and the lines it paired, given `lines`, the whole file as the sides show it. */
export function syntaxLineChanges(
  lines: readonly DiffLine[],
  syntax: SyntaxDiff,
): { marks: Map<DiffLine, Span[]>; partners: Map<DiffLine, DiffLine> } {
  const oldLines: DiffLine[] = [];
  const newLines: DiffLine[] = [];
  const marks = new Map<DiffLine, Span[]>();
  for (const line of lines) {
    if (line.kind !== "add") oldLines.push(line);
    if (line.kind !== "del") newLines.push(line);
    const changes = line.kind === "del" ? syntax.oldChanges[oldLines.length - 1] : line.kind === "add" ? syntax.newChanges[newLines.length - 1] : null;
    if (changes != null) marks.set(line, changes.map(({ start, end }) => ({ start, end })));
  }
  const partners = new Map<DiffLine, DiffLine>();
  for (const [oldIndex, newIndex] of syntax.aligned) {
    const removed = oldIndex == null ? null : oldLines[oldIndex];
    const added = newIndex == null ? null : newLines[newIndex];
    if (removed?.kind === "del" && added?.kind === "add") partners.set(removed, added);
  }
  return { marks, partners };
}
