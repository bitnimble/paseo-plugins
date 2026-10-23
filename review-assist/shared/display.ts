import { type DiffLine, isChange } from "./diff";

export interface SplitRow {
  readonly left: DiffLine | null;
  readonly right: DiffLine | null;
}

const MAX_ALIGNED_BLOCK = 400;
const MAX_WORD_PAIRS = 200 * 200;
const MIN_KEPT_SHARE = 0.4;
const TOKEN = /\w+|\s+|[^\w\s]/g;

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
  const left = before.match(TOKEN) ?? [];
  const right = after.match(TOKEN) ?? [];
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

/** Index pairs of a longest common subsequence of `left` and `right`. */
function commonPairs(left: readonly string[], right: readonly string[]): [number, number][] {
  const lengths = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lengths[i][j] =
        left[i] === right[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pairs.push([i++, j++]);
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
