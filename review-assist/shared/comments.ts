import type { DiffFile } from "./diff";
import type { ContextLine, DraftComment } from "./protocol";
import { type SideLine, rangeHeader } from "./sides";

export type CommentTarget = Omit<DraftComment, "id" | "body" | "createdAt">;

const CONTEXT_LINES = 3;

/** Lines `start` to `end` of `lines`, anchored on the last one as Paseo's Changes panel anchors. */
export function commentTarget(
  file: DiffFile,
  lines: readonly SideLine[],
  start: number,
  end: number,
): CommentTarget | null {
  const target = lines[end];
  if (target == null) return null;
  const side = target.newNumber == null ? "old" : "new";
  const numberOf = (line: Omit<SideLine, "text">) => (side === "new" ? line.newNumber : line.oldNumber);
  const lineNumber = numberOf(target);
  if (lineNumber == null) return null;
  const first = lines.slice(start, end + 1).find((line) => numberOf(line) != null);
  const around = lines.slice(Math.max(0, start - CONTEXT_LINES), end + CONTEXT_LINES + 1);
  const hunk = file.hunks.find((candidate) => candidate.lines.some((line) => numberOf(line) === lineNumber));
  return {
    filePath: file.path,
    side,
    startLine: (first == null ? null : numberOf(first)) ?? lineNumber,
    lineNumber,
    context: {
      hunkHeader: hunk?.header ?? rangeHeader(around),
      targetLine: contextLine(target),
      lines: around.map(contextLine),
    },
  };
}

/** Where `comment` sits among `lines`, or -1 when they do not include its line. */
export function commentLine(comment: DraftComment, lines: readonly Omit<SideLine, "text">[]): number {
  return lines.findIndex(
    (line) => (comment.side === "new" ? line.newNumber : line.oldNumber) === comment.lineNumber,
  );
}

export function withComment(comments: readonly DraftComment[], comment: DraftComment): DraftComment[] {
  return comments.some(({ id }) => id === comment.id)
    ? comments.map((existing) => (existing.id === comment.id ? comment : existing))
    : [...comments, comment];
}

export function rangeLabel(comment: Pick<DraftComment, "startLine" | "lineNumber">): string {
  return comment.startLine === comment.lineNumber
    ? `Line ${comment.lineNumber}`
    : `Lines ${comment.startLine}–${comment.lineNumber}`;
}

function contextLine(line: SideLine): ContextLine {
  return {
    oldLineNumber: line.oldNumber,
    newLineNumber: line.newNumber,
    type: line.oldNumber == null ? "add" : line.newNumber == null ? "remove" : "context",
    content: line.text,
  };
}
