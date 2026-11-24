import { type DiffFile, type DiffHunk, LINE_PREFIX, type ParsedDiff, isChange } from "./diff";
import { hashText } from "./hash";

export interface DiffChunk {
  readonly hunk: DiffHunk;
  readonly start: number;
  readonly end: number;
}

export interface FileBlock {
  readonly file: DiffFile;
  readonly chunks: readonly DiffChunk[];
  /** Changes later sections make to this file: neither side of this block has them yet. */
  readonly later: readonly DiffChunk[];
}

export function fullBlocks(diff: ParsedDiff): FileBlock[] {
  return diff.files.map((file) => ({
    file,
    chunks: file.hunks.map((hunk) => ({ hunk, start: 0, end: hunk.lines.length })),
    later: [],
  }));
}

export function isWholeFile(block: FileBlock): boolean {
  return block.later.length === 0 && blockLines(block) === block.file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
}

/** Covers the block's own changes only, not the lines around them. */
export function blockFingerprint(block: FileBlock): string {
  const { file } = block;
  const shown =
    file.hunks.length === 0
      ? file.header
      : block.chunks.flatMap(({ hunk, start, end }) =>
          hunk.lines.slice(start, end).flatMap((line) => (isChange(line) ? [LINE_PREFIX[line.kind] + line.text] : [])),
        );
  return hashText([file.oldPath ?? "", file.path, ...shown].join("\n"));
}

export function blockLines(block: FileBlock): number {
  return block.chunks.reduce((sum, chunk) => sum + chunk.end - chunk.start, 0);
}

export function blockChanges(block: FileBlock): number {
  const { additions, deletions } = blockCounts(block);
  return additions + deletions;
}

export function blockCounts(block: FileBlock): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const { hunk, start, end } of block.chunks) {
    for (let i = start; i < end; i++) {
      if (hunk.lines[i].kind === "add") additions++;
      if (hunk.lines[i].kind === "del") deletions++;
    }
  }
  return { additions, deletions };
}
