import { type MarkedToken, type Token, type Tokens, lexer } from "marked";
import { MIN_KEPT_SHARE, WORD_TOKEN, commonPairs } from "../shared/display";
import { messageOf } from "../shared/errors";
import type { MarkdownBlock, MarkdownEntry, MarkdownOutcome, MarkdownRun } from "../shared/protocol";

type Placed = Omit<MarkdownEntry, "change" | "lines">;
type Context = Omit<Placed, "block">;
type Style = Omit<MarkdownRun, "text" | "change">;
type Change = "added" | "removed";
type Pairs = readonly (readonly [number, number])[];
type TableBlock = Extract<MarkdownBlock, { kind: "table" }>;
type TableRow = TableBlock["rows"][number];

interface Parsed {
  readonly placed: Placed;
  /** The source it was lexed from, which in a quote or list item has their markers taken off. */
  readonly raw: string;
}

interface Located {
  readonly placed: Placed;
  readonly lines: { readonly start: number; readonly end: number } | null;
}

/** A column of a merged table, by its index in each version. */
interface Column {
  readonly old: number | null;
  readonly now: number | null;
}

interface Gap {
  readonly from: number;
  readonly to: number;
}

const PLAIN: Style = { strong: false, em: false, code: false, strike: false, href: null, image: false };
const MAX_GAP_PAIRS = 20 * 20;
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const LOOSE_LOOKAHEAD = 4;
const LINE_MARKERS = /^(?:\s*(?:>|[-*+](?=\s)|\d{1,9}[.)](?=\s)|\[[ xX]\](?=\s)))*\s*/;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: String.fromCharCode(0xa0),
};

export function markdownDiff(before: string, after: string): MarkdownOutcome {
  let entries: MarkdownEntry[];
  try {
    entries = diffDocuments(parse(before), parse(after));
  } catch (error) {
    // The lexer recurses per level of nesting, so a deep enough quote or list overflows the stack.
    return { status: "unavailable", reason: messageOf(error) };
  }
  if (entries.every(({ change }) => change === "same")) {
    return { status: "unavailable", reason: "Only the markdown source changed, not how it reads." };
  }
  return { status: "ready", entries };
}

function parse(source: string): Located[] {
  const parsed: Parsed[] = [];
  const front = FRONT_MATTER.exec(source)?.[0] ?? "";
  if (front !== "") {
    const placed: Placed = { quote: 0, list: null, block: codeBlock(front.trimEnd()) };
    parsed.push({ placed, raw: front });
  }
  // Blank lines in its place keep the rest of the document on its own line numbers.
  const body = front.replace(/[^\n]/g, "") + source.slice(front.length);
  addBlocks(known(lexer(body, { gfm: true })), { quote: 0, list: null }, parsed);
  return locate(source.split("\n"), parsed);
}

/** No extensions are registered, so the lexer makes only built-in tokens. */
function known(tokens: Token[] | undefined): readonly MarkedToken[] {
  return (tokens ?? []) as MarkedToken[];
}

function addBlocks(tokens: readonly MarkedToken[], context: Context, out: Parsed[]): void {
  for (const token of tokens) {
    const add = (block: MarkdownBlock) => out.push({ placed: { ...context, block }, raw: token.raw });
    switch (token.type) {
      case "heading":
        add({ kind: "heading", depth: token.depth, runs: runsOf(token.tokens) });
        break;
      case "paragraph":
        add({ kind: "text", runs: runsOf(token.tokens) });
        break;
      case "text":
        add({ kind: "text", runs: token.tokens == null ? textRuns(token.text, PLAIN) : runsOf(token.tokens) });
        break;
      case "code":
        add(codeBlock(token.text));
        break;
      case "html":
        if (!/^\s*<!--[\s\S]*-->\s*$/.test(token.text)) add(codeBlock(token.text.trimEnd()));
        break;
      case "hr":
        add({ kind: "rule" });
        break;
      case "blockquote":
        addBlocks(known(token.tokens), { ...context, quote: context.quote + 1 }, out);
        break;
      case "list":
        token.items.forEach((item, index) => addItem(item, itemMarker(token, item, index), context, out));
        break;
      case "table":
        add({
          kind: "table",
          columns: token.align.map((align) => ({ align, change: null })),
          rows: [tableRow(token.header, true), ...token.rows.map((cells) => tableRow(cells, false))],
        });
        break;
    }
  }
}

function addItem(item: Tokens.ListItem, marker: string, context: Context, out: Parsed[]): void {
  const depth = (context.list?.depth ?? 0) + 1;
  const start = out.length;
  addBlocks(known(item.tokens), { quote: context.quote, list: { depth, marker: null } }, out);
  const first = out.length > start ? out[start] : null;
  if (first != null && first.placed.list?.depth === depth) {
    out[start] = { ...first, placed: { ...first.placed, list: { depth, marker } } };
  } else {
    const placed: Placed = { quote: context.quote, list: { depth, marker }, block: { kind: "text", runs: [] } };
    out.splice(start, 0, { placed, raw: item.raw.split("\n")[0] });
  }
}

function itemMarker(list: Tokens.List, item: Tokens.ListItem, index: number): string {
  if (item.task) return item.checked === true ? "☑" : "☐";
  if (!list.ordered) return "•";
  return `${(list.start === "" ? 1 : list.start) + index}.`;
}

function tableRow(cells: readonly Tokens.TableCell[], header: boolean): TableRow {
  return { header, cells: cells.map((cell) => runsOf(cell.tokens)), change: null };
}

function codeBlock(text: string): MarkdownBlock {
  return { kind: "code", lines: text.split("\n").map((line) => ({ text: line, change: null })) };
}

function locate(lines: readonly string[], parsed: readonly Parsed[]): Located[] {
  const bare = lines.map((line) => line.replace(LINE_MARKERS, "").trimEnd());
  // A line merely containing the text, like a skipped comment or link definition, yields to an exact one just after.
  const find = (text: string, from: number) => {
    let loose = -1;
    for (let i = from; i < lines.length && (loose < 0 || i <= loose + LOOSE_LOOKAHEAD); i++) {
      if (bare[i] === text) return i;
      if (loose < 0 && lines[i].includes(text)) loose = i;
    }
    return loose;
  };
  let cursor = 0;
  return parsed.map(({ placed, raw }) => {
    const written = raw.trim().split("\n");
    const start = written[0] === "" ? -1 : find(written[0].trim(), cursor);
    if (start < 0) return { placed, lines: null };
    // Quotes and list items take their markers off a block's lines, never whole lines.
    const end = Math.min(lines.length - 1, start + written.length - 1);
    cursor = end + 1;
    return { placed, lines: { start, end } };
  });
}

function runsOf(tokens: Token[] | undefined, style: Style = PLAIN): MarkdownRun[] {
  return coalesce(known(tokens).flatMap((token) => inlineRuns(token, style)));
}

function inlineRuns(token: MarkedToken, style: Style): MarkdownRun[] {
  switch (token.type) {
    case "strong":
      return runsOf(token.tokens, { ...style, strong: true });
    case "em":
      return runsOf(token.tokens, { ...style, em: true });
    case "del":
      return runsOf(token.tokens, { ...style, strike: true });
    case "link":
      return runsOf(token.tokens, { ...style, href: token.href });
    case "image":
      return [run(decodeEntities(token.text), { ...style, href: token.href, image: true })];
    case "codespan":
      return [run(token.text, { ...style, code: true })];
    case "br":
      return [run("\n", style)];
    case "html":
      return /^<br\s*\/?>$/i.test(token.text) ? [run("\n", style)] : [];
    case "escape":
      return [run(token.text, style)];
    case "text":
      return token.tokens == null ? textRuns(token.text, style) : runsOf(token.tokens, style);
    default:
      return [];
  }
}

function textRuns(text: string, style: Style): MarkdownRun[] {
  return [run(decodeEntities(text).replace(/\n/g, " "), style)];
}

function run(text: string, style: Style): MarkdownRun {
  return { text, ...style, change: null };
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (!name.startsWith("#")) return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function coalesce(runs: readonly MarkdownRun[]): MarkdownRun[] {
  const out: MarkdownRun[] = [];
  for (const next of runs) {
    if (next.text === "") continue;
    const last = out.at(-1);
    if (last != null && last.change === next.change && sameStyle(last, next)) {
      out[out.length - 1] = { ...last, text: last.text + next.text };
    } else {
      out.push(next);
    }
  }
  return out;
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    a.strong === b.strong &&
    a.em === b.em &&
    a.code === b.code &&
    a.strike === b.strike &&
    a.href === b.href &&
    a.image === b.image
  );
}

function withChange(runs: readonly MarkdownRun[], change: Change): MarkdownRun[] {
  return runs.map((piece) => ({ ...piece, change }));
}

function diffDocuments(old: readonly Located[], now: readonly Located[]): MarkdownEntry[] {
  return interleaveGroups(
    commonPairs(old.map(blockKey), now.map(blockKey)),
    old.length,
    now.length,
    (i, j) =>
      pairSimilar(
        old.slice(i.from, i.to),
        now.slice(j.from, j.to),
        (a) => entry("removed", a.placed, a, "old"),
        (b) => entry("added", b.placed, b, "new"),
        (a, b) => {
          const block = mergeBlocks(a.placed.block, b.placed.block);
          return block == null ? null : entry("changed", { ...b.placed, block }, b, "new");
        },
      ),
    (_, j) => entry("same", now[j].placed, now[j], "new"),
  );
}

/** Without an ordered item's number, so renumbering a list leaves its items unchanged. */
function blockKey({ placed }: Located): string {
  const marker = placed.list?.marker?.replace(/^\d+\.$/, "#.") ?? null;
  return JSON.stringify(placed.list == null ? placed : { ...placed, list: { ...placed.list, marker } });
}

function entry(change: MarkdownEntry["change"], placed: Placed, at: Located, side: "old" | "new"): MarkdownEntry {
  return { change, ...placed, lines: at.lines == null ? null : { side, ...at.lines } };
}

function pairSimilar<A, B, T>(
  removed: readonly A[],
  added: readonly B[],
  onlyRemoved: (item: A) => T,
  onlyAdded: (item: B) => T,
  merge: (a: A, b: B) => T | null,
): T[] {
  const merged =
    removed.length * added.length > MAX_GAP_PAIRS ? null : removed.map((a) => added.map((b) => merge(a, b)));
  const pairs =
    merged == null
      ? []
      : commonPairs(
          removed.map((_, i) => i),
          added.map((_, j) => j),
          (i, j) => merged[i][j] != null,
        );
  return interleaveGroups(
    pairs,
    removed.length,
    added.length,
    (i, j) => [...removed.slice(i.from, i.to).map(onlyRemoved), ...added.slice(j.from, j.to).map(onlyAdded)],
    (i, j) => merged?.[i][j] ?? onlyAdded(added[j]),
  );
}

/** Null when the two are different kinds of block, or one rewrites the other. */
function mergeBlocks(a: MarkdownBlock, b: MarkdownBlock): MarkdownBlock | null {
  const sameHeading = a.kind === "heading" && b.kind === "heading" && a.depth === b.depth;
  if (sameHeading || (a.kind === "text" && b.kind === "text")) {
    const runs = mergeRuns(a.runs, b.runs);
    return runs == null ? null : { ...b, runs };
  }
  if (a.kind === "code" && b.kind === "code") {
    const pairs = commonPairs(
      a.lines.map(({ text }) => text),
      b.lines.map(({ text }) => text),
    );
    if (pairs.length < MIN_KEPT_SHARE * Math.max(a.lines.length, b.lines.length)) return null;
    return {
      ...b,
      lines: interleave(
        pairs,
        a.lines.length,
        b.lines.length,
        (i) => ({ ...a.lines[i], change: "removed" as const }),
        (j) => ({ ...b.lines[j], change: "added" as const }),
        (_, j) => b.lines[j],
      ),
    };
  }
  if (a.kind === "table" && b.kind === "table") {
    const table = mergeTables(a, b);
    return table.rows.every((row) => row.change != null) ? null : table;
  }
  if (a.kind === "rule" && b.kind === "rule") return b;
  return null;
}

function mergeTables(a: TableBlock, b: TableBlock): TableBlock {
  const columns = alignColumns(a, b);
  const shared = columns.filter((column) => column.old != null && column.now != null);
  const key = (row: TableRow, index: (column: Column) => number | null) =>
    JSON.stringify([row.header, shared.map((column) => cellAt(row, index(column)))]);
  const pairs = commonPairs(
    a.rows.map((row) => key(row, ({ old }) => old)),
    b.rows.map((row) => key(row, ({ now }) => now)),
  );
  const onlyRemoved = (row: TableRow): TableRow => ({
    header: row.header,
    cells: columns.map(({ old }) => cellAt(row, old)),
    change: "removed",
  });
  const onlyAdded = (row: TableRow): TableRow => ({
    header: row.header,
    cells: columns.map(({ now }) => cellAt(row, now)),
    change: "added",
  });
  const rows = interleaveGroups(
    pairs,
    a.rows.length,
    b.rows.length,
    (i, j) =>
      pairSimilar(a.rows.slice(i.from, i.to), b.rows.slice(j.from, j.to), onlyRemoved, onlyAdded, (before, after) =>
        alike(before, after, shared) ? mergeRow(before, after, columns) : null,
      ),
    (i, j) => mergeRow(a.rows[i], b.rows[j], columns),
  );
  return {
    kind: "table",
    columns: columns.map(({ old, now }) => ({
      align: now != null ? b.columns[now].align : old != null ? a.columns[old].align : null,
      change: old == null ? "added" : now == null ? "removed" : null,
    })),
    rows,
  };
}

function alignColumns(a: TableBlock, b: TableBlock): Column[] {
  const names = (table: TableBlock) => table.columns.map((_, i) => plainText(cellAt(table.rows[0], i)));
  return interleaveGroups<Column>(
    commonPairs(names(a), names(b)),
    a.columns.length,
    b.columns.length,
    (i, j) =>
      i.to - i.from === j.to - j.from
        ? range(i.from, i.to).map((old) => ({ old, now: j.from + old - i.from }))
        : [
            ...range(i.from, i.to).map((old) => ({ old, now: null })),
            ...range(j.from, j.to).map((now) => ({ old: null, now })),
          ],
    (old, now) => ({ old, now }),
  );
}

function alike(a: TableRow, b: TableRow, shared: readonly Column[]): boolean {
  if (a.header !== b.header) return false;
  const key = shared.length === 0 ? "" : plainText(cellAt(a, shared[0].old));
  if (key.trim() !== "" && key === plainText(cellAt(b, shared[0].now))) return true;
  const flat = (row: TableRow, index: (column: Column) => number | null) =>
    shared.flatMap((column) => [...cellAt(row, index(column)), run(" ", PLAIN)]);
  return mergeRuns(flat(a, ({ old }) => old), flat(b, ({ now }) => now)) != null;
}

function mergeRow(a: TableRow, b: TableRow, columns: readonly Column[]): TableRow {
  const cells = columns.map(({ old, now }) => {
    if (now == null) return withChange(cellAt(a, old), "removed");
    if (old == null) return withChange(cellAt(b, now), "added");
    const before = cellAt(a, old);
    const after = cellAt(b, now);
    return mergeRuns(before, after) ?? [...withChange(before, "removed"), ...withChange(after, "added")];
  });
  return { header: b.header, cells, change: null };
}

function cellAt(row: TableRow | undefined, index: number | null): MarkdownRun[] {
  return index == null ? [] : (row?.cells[index] ?? []);
}

function plainText(runs: readonly MarkdownRun[]): string {
  return runs.map(({ text }) => text).join("");
}

/** `right` with the words `left` had in place of its changed ones; null when it is mostly a rewrite. */
function mergeRuns(left: readonly MarkdownRun[], right: readonly MarkdownRun[]): MarkdownRun[] | null {
  const words = (runs: readonly MarkdownRun[]) =>
    runs.flatMap((piece) => (piece.text.match(WORD_TOKEN) ?? []).map((text) => ({ ...piece, text })));
  const before = words(left);
  const after = words(right);
  const length = (runs: readonly MarkdownRun[]) => runs.reduce((sum, run) => sum + run.text.length, 0);
  const needed = MIN_KEPT_SHARE * Math.max(length(left), length(right));
  if (sharedLength(before, after) < needed) return null;
  const pairs = withoutStrayWhitespace(
    commonPairs(before, after, (a, b) => a.text === b.text && sameStyle(a, b)),
    before,
  );
  const kept = pairs.reduce((sum, [i]) => sum + before[i].text.length, 0);
  if (kept < needed) return null;
  return coalesce(
    interleave(
      pairs,
      before.length,
      after.length,
      (i) => ({ ...before[i], change: "removed" as const }),
      (j) => ({ ...after[j], change: "added" as const }),
      (_, j) => after[j],
    ),
  );
}

/** Characters of the words both have, in any order: a bound on what any alignment of them keeps. */
function sharedLength(before: readonly MarkdownRun[], after: readonly MarkdownRun[]): number {
  const counts = new Map<string, number>();
  for (const { text } of before) counts.set(text, (counts.get(text) ?? 0) + 1);
  let shared = 0;
  for (const { text } of after) {
    const left = counts.get(text) ?? 0;
    if (left === 0) continue;
    counts.set(text, left - 1);
    shared += text.length;
  }
  return shared;
}

function withoutStrayWhitespace(pairs: Pairs, words: readonly MarkdownRun[]): Pairs {
  const isWord = (k: number) => k >= 0 && k < pairs.length && words[pairs[k][0]].text.trim() !== "";
  const touches = (k: number, step: number) =>
    isWord(k + step) && pairs[k + step][0] === pairs[k][0] + step && pairs[k + step][1] === pairs[k][1] + step;
  return pairs.filter(([i], k) => words[i].text.trim() !== "" || touches(k, -1) || touches(k, 1));
}

function interleave<T>(
  pairs: Pairs,
  leftLength: number,
  rightLength: number,
  removed: (i: number) => T,
  added: (j: number) => T,
  both: (i: number, j: number) => T,
): T[] {
  return interleaveGroups(
    pairs,
    leftLength,
    rightLength,
    (i, j) => [...range(i.from, i.to).map(removed), ...range(j.from, j.to).map(added)],
    both,
  );
}

function interleaveGroups<T>(
  pairs: Pairs,
  leftLength: number,
  rightLength: number,
  unpaired: (left: Gap, right: Gap) => T[],
  both: (i: number, j: number) => T,
): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [leftLength, rightLength] as const]) {
    out.push(...unpaired({ from: i, to: pi }, { from: j, to: pj }));
    if (pi < leftLength) out.push(both(pi, pj));
    i = pi + 1;
    j = pj + 1;
  }
  return out;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
}
