import { z } from "zod";
import { type DiffFile, type DiffHunk, LINE_PREFIX, type ParsedDiff, isChange } from "./diff";
import { hashText } from "./hash";

/** What the segmenting agent returns: references into the diff, never diff text. */
export const proposalSchema = z.object({
  sections: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      // Agents drop empty lists despite the prompt; a missing one only leaves lines to "Other changes".
      regions: z.array(z.object({ hunk: z.string(), from: z.number().int(), to: z.number().int() })).default([]),
      files: z.array(z.string()).default([]),
    }),
  ),
});
export type Proposal = z.infer<typeof proposalSchema>;

const guideRegionSchema =z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("lines"),
    hunkId: z.string(),
    start: z.number().int(),
    end: z.number().int(),
  }),
  z.object({ kind: z.literal("file"), fileIndex: z.number().int() }),
]);
export type GuideRegion = z.infer<typeof guideRegionSchema>;

export const guideSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  regions: z.array(guideRegionSchema),
});
export type GuideSection = z.infer<typeof guideSectionSchema>;

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

const UNCLAIMED = -1;

/**
 * Turns a proposal into sections that partition the diff exactly: every line of every hunk, and
 * every file without hunks, lands in one section. Whatever the proposal misses goes to "Other
 * changes", and the first section to claim a line keeps it.
 */
export function buildGuide(diff: ParsedDiff, proposal: Proposal): GuideSection[] {
  const drafts = proposal.sections.map((section) => ({
    title: section.title.trim() === "" ? "Untitled section" : section.title.trim(),
    description: section.description.trim(),
  }));
  const generatedOwner = drafts.push({
    title: "Generated files",
    description: "Lockfiles and build output, kept out of the other sections. Skim for unexpected churn.",
  }) - 1;
  const otherOwner = drafts.push({
    title: "Other changes",
    description: "Changes the guided review did not place in a section.",
  }) - 1;

  const owners = new Map<string, number[]>();
  const fileOwners = new Map<number, number>();
  const firstMention = drafts.map(() => new Map<number, number>());
  let mentions = 0;
  const mention = (owner: number, fileIndex: number) => {
    if (!firstMention[owner].has(fileIndex)) firstMention[owner].set(fileIndex, mentions++);
  };
  const ownersOf = (hunk: DiffHunk): number[] => {
    let lines = owners.get(hunk.id);
    if (lines == null) {
      lines = hunk.lines.map(() => UNCLAIMED);
      owners.set(hunk.id, lines);
    }
    return lines;
  };
  const claim = (owner: number, hunk: DiffHunk, from: number, to: number) => {
    const lines = ownersOf(hunk);
    for (let i = Math.max(0, from); i <= Math.min(lines.length - 1, to); i++) {
      if (lines[i] === UNCLAIMED) lines[i] = owner;
    }
  };
  const claimFile = (owner: number, file: DiffFile) => {
    if (file.hunks.length === 0 && !fileOwners.has(file.index)) {
      fileOwners.set(file.index, owner);
    }
    for (const hunk of file.hunks) claim(owner, hunk, 0, hunk.lines.length - 1);
  };

  for (const file of diff.files) {
    if (file.generated) claimFile(generatedOwner, file);
  }
  proposal.sections.forEach((section, owner) => {
    for (const region of section.regions) {
      const hunk = diff.hunks.get(region.hunk.trim().toLowerCase());
      if (hunk == null) continue;
      claim(owner, hunk, Math.min(region.from, region.to), Math.max(region.from, region.to));
      mention(owner, hunk.fileIndex);
    }
    for (const ref of section.files) {
      const file = diff.files[fileIndexOf(ref)];
      if (file == null) continue;
      claimFile(owner, file);
      mention(owner, file.index);
    }
  });

  const regions = drafts.map(() => new Map<number, GuideRegion[]>());
  const place = (owner: number, fileIndex: number, region: GuideRegion) => {
    const byFile = regions[owner];
    const placed = byFile.get(fileIndex);
    if (placed == null) byFile.set(fileIndex, [region]);
    else placed.push(region);
  };
  for (const file of diff.files) {
    if (file.hunks.length === 0) {
      place(fileOwners.get(file.index) ?? otherOwner, file.index, { kind: "file", fileIndex: file.index });
      continue;
    }
    for (const hunk of file.hunks) {
      const lines = settleOwners(hunk, ownersOf(hunk), otherOwner);
      let start = 0;
      for (let i = 1; i <= lines.length; i++) {
        if (i === lines.length || lines[i] !== lines[start]) {
          place(lines[start], file.index, { kind: "lines", hunkId: hunk.id, start, end: i });
          start = i;
        }
      }
    }
  }

  const sections = drafts.flatMap((draft, owner) => {
    const rank = (fileIndex: number) => firstMention[owner].get(fileIndex) ?? mentions + fileIndex;
    const files = [...regions[owner].keys()].sort((a, b) => rank(a) - rank(b));
    if (files.length === 0) return [];
    return [{ ...draft, regions: files.flatMap((fileIndex) => regions[owner].get(fileIndex) ?? []) }];
  });
  const guide = sections.map((section, index) => ({ id: `s${index}`, ...section }));
  composeGuide(diff, guide);
  return guide;
}

/**
 * Reassembles the diff from a guide's regions, throwing unless they tile every hunk and cover every
 * hunkless file exactly once. `serializeDiff` of the result equals the original diff text.
 */
export function composeGuide(diff: ParsedDiff, sections: readonly GuideSection[]): Pick<ParsedDiff, "files" | "trailingNewline"> {
  const ranges = new Map<string, { start: number; end: number }[]>();
  const files = new Set<number>();
  for (const section of sections) {
    for (const region of section.regions) {
      if (region.kind === "file") {
        if (files.has(region.fileIndex)) throw new Error(`File ${region.fileIndex} appears twice`);
        files.add(region.fileIndex);
        continue;
      }
      if (!diff.hunks.has(region.hunkId)) throw new Error(`Unknown hunk ${region.hunkId}`);
      ranges.set(region.hunkId, [...(ranges.get(region.hunkId) ?? []), region]);
    }
  }

  return {
    trailingNewline: diff.trailingNewline,
    files: diff.files.map((file) => {
      if (file.hunks.length === 0) {
        if (!files.has(file.index)) throw new Error(`File ${file.path} is missing from the guide`);
        return file;
      }
      if (files.has(file.index)) throw new Error(`File ${file.path} has hunks but a file region`);
      return {
        ...file,
        hunks: file.hunks.map((hunk) => {
          const tiles = [...(ranges.get(hunk.id) ?? [])].sort((a, b) => a.start - b.start);
          let next = 0;
          for (const tile of tiles) {
            if (tile.start !== next || tile.end <= tile.start) {
              throw new Error(`Hunk ${hunk.id} is not tiled exactly at line ${next}`);
            }
            next = tile.end;
          }
          if (next !== hunk.lines.length) throw new Error(`Hunk ${hunk.id} is not covered past line ${next}`);
          return { ...hunk, lines: tiles.flatMap((tile) => hunk.lines.slice(tile.start, tile.end)) };
        }),
      };
    }),
  };
}

export function fullBlocks(diff: ParsedDiff): FileBlock[] {
  return diff.files.map((file) => ({
    file,
    chunks: file.hunks.map((hunk) => ({ hunk, start: 0, end: hunk.lines.length })),
    later: [],
  }));
}

/**
 * Each section's files in the order it names them. A section sees the changes of the sections
 * before it as already made and those after it as not made yet.
 */
export function guideBlocks(diff: ParsedDiff, sections: readonly GuideSection[]): FileBlock[][] {
  const owned = sections.map((section) => sectionChunks(diff, section));
  return owned.map((files, index) =>
    [...files].map(([file, chunks]) => ({
      file,
      chunks,
      later: owned.slice(index + 1).flatMap((next) => next.get(file) ?? []),
    })),
  );
}

function sectionChunks(diff: ParsedDiff, section: GuideSection): Map<DiffFile, DiffChunk[]> {
  const files = new Map<DiffFile, DiffChunk[]>();
  for (const region of section.regions) {
    const hunk = region.kind === "lines" ? diff.hunks.get(region.hunkId) : undefined;
    const file = diff.files[region.kind === "file" ? region.fileIndex : (hunk?.fileIndex ?? -1)];
    if (file == null) continue;
    const chunks = files.get(file) ?? [];
    if (region.kind === "lines" && hunk != null) chunks.push({ hunk, start: region.start, end: region.end });
    files.set(file, chunks);
  }
  return files;
}

export function isWholeFile(block: FileBlock): boolean {
  const lines = (chunks: readonly DiffChunk[]) => chunks.reduce((sum, chunk) => sum + chunk.end - chunk.start, 0);
  return block.later.length === 0 && lines(block.chunks) === block.file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
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

function fileIndexOf(ref: string): number {
  const match = /^f(\d+)$/i.exec(ref.trim());
  return match == null ? -1 : Number(match[1]);
}

function settleOwners(hunk: DiffHunk, claimed: readonly number[], fallback: number): number[] {
  const owners = claimed.map((owner, i) =>
    isChange(hunk.lines[i]) && owner === UNCLAIMED ? fallback : owner,
  );
  const changes = hunk.lines.flatMap((line, i) => (isChange(line) ? [i] : []));
  if (changes.length === 0) return owners.map(() => fallback);

  let next = 0;
  return owners.map((owner, i) => {
    if (isChange(hunk.lines[i])) {
      next++;
      return owner;
    }
    const before = changes[next - 1];
    const after = changes[next];
    if (before == null) return owners[after];
    if (after == null) return owners[before];
    return i - before <= Math.ceil((after - before - 1) / 2) ? owners[before] : owners[after];
  });
}
