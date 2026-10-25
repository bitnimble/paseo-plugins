import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { isEdit, rangeLabel } from "../shared/comments";
import type { DraftComment } from "../shared/protocol";

export interface SuggestionResult {
  readonly applied: readonly DraftComment[];
  /** The other comments, with new-side line numbers moved past the applied edits. */
  readonly rest: readonly DraftComment[];
}

/** Writes each suggested edit into the working tree, all or none. */
export async function applySuggestions(root: string, comments: readonly DraftComment[]): Promise<SuggestionResult> {
  const applied = comments.filter(isEdit);
  const files: { path: string; before: Buffer; after: string }[] = [];
  for (const filePath of new Set(applied.map((comment) => comment.filePath))) {
    const path = join(root, filePath);
    const inside = relative(root, path);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error(`${filePath} is outside the repository.`);
    }
    const before = await readFile(path);
    const text = before.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(before)) throw new Error(`${filePath} isn't UTF-8 text, so it can't be edited.`);
    files.push({ path, before, after: applyEdits(text, applied.filter((comment) => comment.filePath === filePath)) });
  }
  const written: typeof files = [];
  try {
    for (const file of files) {
      await writeFile(file.path, file.after);
      written.push(file);
    }
  } catch (error) {
    await Promise.allSettled(written.map(({ path, before }) => writeFile(path, before)));
    throw error;
  }
  const rest = comments.filter((comment) => !applied.includes(comment)).map((comment) => shifted(comment, applied));
  return { applied, rest };
}

/** `text` with each comment's lines replaced by its suggestion; throws if any lines differ from the original. */
export function applyEdits(text: string, comments: readonly DraftComment[]): string {
  // Diff text keeps a CRLF file's "\r"s, and the composer drops them; compare and write without, then restore.
  let lines = text.split("\n");
  const bare = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);
  const lineCount = text === "" ? 0 : text.endsWith("\n") ? lines.length - 1 : lines.length;
  const edits = [...comments].sort((a, b) => b.startLine - a.startLine);
  edits.forEach((edit, i) => {
    const below = edits[i - 1];
    if (below != null && below.startLine <= edit.lineNumber) {
      throw new Error(`Suggestions on ${edit.filePath} ${rangeLabel(edit).toLowerCase()} and ${rangeLabel(below).toLowerCase()} overlap.`);
    }
    const current = lines.slice(edit.startLine - 1, edit.lineNumber).map(bare).join("\n");
    if (edit.lineNumber > lineCount || current !== edit.suggestion?.original) {
      throw new Error(`${edit.filePath} ${rangeLabel(edit).toLowerCase()} changed since the suggestion; edit or delete it.`);
    }
  });
  const crlf = text.includes("\r\n");
  for (const edit of edits) {
    const replaced = replacementLines(edit);
    const lastEnding = lines[edit.lineNumber - 1].endsWith("\r") ? "\r" : "";
    const ended = replaced.map((line, i) => line + (i === replaced.length - 1 ? lastEnding : crlf ? "\r" : ""));
    lines = lines.slice(0, edit.startLine - 1).concat(ended, lines.slice(edit.lineNumber));
  }
  return lines.join("\n");
}

/** `comment` renumbered for the edits before or inside its lines. */
function shifted(comment: DraftComment, edits: readonly DraftComment[]): DraftComment {
  if (comment.side === "old") return comment;
  const deltaUpTo = (line: number) =>
    edits
      .filter((edit) => edit.filePath === comment.filePath && edit.lineNumber <= line)
      .reduce((sum, edit) => sum + replacementLines(edit).length - (edit.lineNumber - edit.startLine + 1), 0);
  return { ...comment, startLine: comment.startLine + deltaUpTo(comment.startLine - 1), lineNumber: comment.lineNumber + deltaUpTo(comment.lineNumber) };
}

/** An empty suggestion deletes the lines. */
function replacementLines(comment: DraftComment): string[] {
  const replacement = comment.suggestion?.replacement ?? "";
  return replacement === "" ? [] : replacement.split("\n");
}
