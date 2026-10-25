import { type DiffLine, isChange } from "./diff";

export interface SplitRow {
  readonly left: DiffLine | null;
  readonly right: DiffLine | null;
}

const MAX_ALIGNED_BLOCK = 400;
const MAX_WORD_PAIRS = 200 * 200;
const MAX_LCS_CELLS = 4_000_000;
/** Below this share of their text in common, two versions read as a rewrite rather than an edit. */
export const MIN_KEPT_SHARE = 0.4;
export const WORD_TOKEN = /\w+|\s+|[^\w\s]/gu;

/**
 * Shows lines that changed only in whitespace as context, the way `git diff -w` would. Display
 * only: the lines still belong to the same hunk and section.
 */
export function hideWhitespaceChanges(lines: readonly DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  forEachBlock(lines, (context) => out.push(context), (removed, added) => {
    let r = 0;
    let a = 0;
    const copyUpTo = (endR: number, endA: number) => {
      while (r < endR) out.push(removed[r++]);
      while (a < endA) out.push(added[a++]);
    };
    for (const [matchR, matchA] of alignIgnoringWhitespace(removed, added)) {
      copyUpTo(matchR, matchA);
      out.push({ ...added[a++], kind: "context", oldNumber: removed[r++].oldNumber });
    }
    copyUpTo(removed.length, added.length);
  });
  return out;
}

/** Pairs removals with additions row by row; context sits on both sides. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  forEachBlock(lines, (context) => rows.push({ left: context, right: context }), (removed, added) => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
    }
  });
  return rows;
}

function forEachBlock(
  lines: readonly DiffLine[],
  onContext: (line: DiffLine) => void,
  onChanges: (removed: DiffLine[], added: DiffLine[]) => void,
): void {
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    if (removed.length > 0 || added.length > 0) onChanges(removed, added);
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (!isChange(line)) {
      flush();
      onContext(line);
    } else if (line.kind === "del" && added.length > 0) {
      flush();
      removed.push(line);
    } else {
      (line.kind === "del" ? removed : added).push(line);
    }
  }
  flush();
}

/**
 * The characters of each removed and added line that differ from the line it pairs with, the
 * first removal of a run with the first addition and so on. Lines mostly rewritten get none.
 */
export function wordChanges(lines: readonly DiffLine[]): Map<DiffLine, Span[]> {
  const changes = new Map<DiffLine, Span[]>();
  forEachBlock(lines, () => undefined, (removed, added) => {
    for (let i = 0; i < Math.min(removed.length, added.length); i++) {
      const spans = changedSpans(removed[i].text, added[i].text);
      if (spans == null) continue;
      changes.set(removed[i], spans.old);
      changes.set(added[i], spans.new);
    }
  });
  return changes;
}

export interface Span {
  readonly start: number;
  readonly end: number;
}

function changedSpans(before: string, after: string): { old: Span[]; new: Span[] } | null {
  const left = before.match(WORD_TOKEN) ?? [];
  const right = after.match(WORD_TOKEN) ?? [];
  if (left.length * right.length > MAX_WORD_PAIRS) return null;
  const pairs = commonPairs(left, right);
  const kept = pairs.reduce((sum, [i]) => sum + left[i].length, 0);
  if (kept < MIN_KEPT_SHARE * Math.max(before.length, after.length)) return null;
  return { old: unmatched(left, pairs.map(([i]) => i)), new: unmatched(right, pairs.map(([, j]) => j)) };
}

/** Spans of the tokens not in `matched`, joined across whitespace. */
function unmatched(tokens: readonly string[], matched: readonly number[]): Span[] {
  const kept = new Set(matched);
  const text = tokens.join("");
  const spans: Span[] = [];
  let offset = 0;
  tokens.forEach((token, i) => {
    const end = offset + token.length;
    const last = spans[spans.length - 1];
    if (!kept.has(i)) {
      if (last != null && /^\s*$/.test(text.slice(last.end, offset))) spans[spans.length - 1] = { start: last.start, end };
      else spans.push({ start: offset, end });
    }
    offset = end;
  });
  return spans;
}

function alignIgnoringWhitespace(removed: readonly DiffLine[], added: readonly DiffLine[]): [number, number][] {
  const left = removed.map((line) => line.text.replace(/\s+/g, ""));
  const right = added.map((line) => line.text.replace(/\s+/g, ""));
  if (left.length * right.length > MAX_ALIGNED_BLOCK * MAX_ALIGNED_BLOCK) {
    return left.flatMap((text, i): [number, number][] => (text === right[i] ? [[i, i]] : []));
  }
  return commonPairs(left, right);
}

/**
 * Index pairs of a longest common subsequence of `left` and `right`, items matching by `same`. Too
 * long a stretch between their common ends pairs only the items level with each other instead.
 */
export function commonPairs<T>(
  left: readonly T[],
  right: readonly T[],
  same: (a: T, b: T) => boolean = (a, b) => a === b,
): [number, number][] {
  let head = 0;
  while (head < left.length && head < right.length && same(left[head], right[head])) head++;
  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    same(left[left.length - 1 - tail], right[right.length - 1 - tail])
  ) {
    tail++;
  }
  const leftEnd = left.length - tail;
  const rightEnd = right.length - tail;
  const pairs: [number, number][] = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  if ((leftEnd - head) * (rightEnd - head) > MAX_LCS_CELLS) {
    for (let k = head; k < Math.min(leftEnd, rightEnd); k++) if (same(left[k], right[k])) pairs.push([k, k]);
  } else {
    pairs.push(...middlePairs(left, right, same, head, leftEnd, rightEnd));
  }
  for (let k = tail; k > 0; k--) pairs.push([left.length - k, right.length - k]);
  return pairs;
}

function middlePairs<T>(
  left: readonly T[],
  right: readonly T[],
  same: (a: T, b: T) => boolean,
  start: number,
  leftEnd: number,
  rightEnd: number,
): [number, number][] {
  const rows = leftEnd - start;
  const columns = rightEnd - start;
  const lengths = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      lengths[i][j] = same(left[start + i], right[start + j])
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (same(left[start + i], right[start + j])) {
      pairs.push([start + i++, start + j++]);
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
