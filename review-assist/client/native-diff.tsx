import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Platform, Pressable, Text, View } from "react-native";
import type { CommentTarget } from "../shared/comments";
import type { DiffFile, DiffLine } from "../shared/diff";
import { type Span, type SplitRow, splitRows, wordChanges } from "../shared/display";
import type { FileBlock } from "../shared/guide";
import type { ViewOptions } from "../shared/settings";
import { CONTEXT_LINES, type ShownHunk, blockHunks, hunksOf, takeChanges, wholeFileLines } from "../shared/sides";
import {
  type Card,
  CommentSlot,
  type FileComments,
  type ScopeEdge,
  UnplacedCards,
  cardKey,
  cardLine,
  draftScope,
  fileCards,
  inScope,
  scopeEdges,
} from "./comments";
import { ShowMoreChanges } from "./controls";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, type DiffStyles } from "./diff-styles";
import type { CodeSource } from "./monaco/review-monaco";
import type { SyntaxPalette } from "./monaco/theme";
import { CODE_SURFACE } from "./palette";
import { type ColoredText, type FileSyntax, lineTokens } from "./syntax";
import { useSyntax } from "./use-code";
import { type WindowedRow, WindowedRows } from "./windowed-rows";

const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);
const EXPAND_STEP = 20;
const MAX_REVEAL_ALL = 400;
const NO_RANGES: readonly Range[] = [];

type Range = readonly [number, number];

/** Line ranges shown on request, valid only for the `of` lines they index. */
interface Revealed {
  readonly of: readonly DiffLine[] | null;
  readonly ranges: readonly Range[];
}

export function NativeBody({
  block,
  source,
  view,
  styles,
  theme,
  palette,
  comments,
  changeLimit,
  onShowMore,
  hidden,
  text,
}: {
  block: FileBlock;
  source: CodeSource;
  view: ViewOptions;
  styles: DiffStyles;
  theme: PluginTheme;
  palette: SyntaxPalette | null;
  comments: FileComments;
  changeLimit: number;
  onShowMore(): void;
  hidden: number;
  /** The file as the diff leaves it, once known, to show the lines around the changes. */
  text: string | null;
}) {
  const whole = useMemo(
    () => (text == null ? null : wholeFileLines(block, text, view.hideWhitespace).lines),
    [block, text, view.hideWhitespace],
  );
  const [revealed, setRevealed] = useState<Revealed>({ of: null, ranges: [] });
  const ranges = revealed.of === whole ? revealed.ranges : NO_RANGES;
  const reveal = (range: Range) => setRevealed({ of: whole, ranges: [...ranges, range] });
  const shown = useMemo(() => {
    if (whole == null) return blockHunks(block, view.hideWhitespace, changeLimit);
    const taken = takeChanges(whole, changeLimit);
    return { hunks: hunksOf(taken.lines, CONTEXT_LINES, ranges, taken.cut), cut: taken.cut };
  }, [block, view.hideWhitespace, whole, ranges, changeLimit]);
  const marks = useMemo(() => shown.hunks.map((hunk) => wordChanges(hunk.lines)), [shown]);
  const syntax = useSyntax(source, block.file, block.file.hunks.length > 0 && !block.file.binary && !block.file.lfs);
  const cards = fileCards(comments);
  const unplaced = cards.filter((card) => shown.hunks.every((hunk) => cardLine(card, hunk.lines) < 0));
  const sideways = scrollsSideways(view);
  const scrollX = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // A remounted scroll view starts at 0 without a scroll event to say so.
    if (sideways) scrollX.setValue(0);
  }, [sideways, scrollX]);
  const onScrollX = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: Platform.OS !== "web" }),
    [scrollX],
  );
  const [visibleWidth, setVisibleWidth] = useState<number | null>(null);
  const pinned = sideways ? { width: visibleWidth ?? undefined, transform: [{ translateX: scrollX }] } : null;
  const slot = (card: Card) => (
    <Animated.View key={cardKey(card)} style={pinned}>
      <CommentSlot theme={theme} file={block.file} card={card} comments={comments} />
    </Animated.View>
  );
  const gutter = gutterWidth(block.file);
  const rows = { file: block.file, gutter, view, styles, syntax, palette, cards, comments, slot };
  const gap = (from: number, to: number): WindowedRow[] =>
    to <= from
      ? []
      : [
          {
            key: `gap:${from}`,
            pinned: false,
            estimate: CODE_LINE_HEIGHT,
            render: () => (
              <GapRow
                from={from}
                to={to}
                total={whole?.length ?? 0}
                gutter={gutter}
                theme={theme}
                styles={styles}
                onReveal={reveal}
              />
            ),
          },
        ];
  const last = shown.hunks[shown.hunks.length - 1];
  const body: WindowedRow[] = [
    ...shown.hunks.flatMap((hunk, i) => [
      ...(whole == null
        ? [
            {
              key: `header:${i}`,
              pinned: false,
              estimate: CODE_LINE_HEIGHT,
              render: () => <MutedRow text={hunk.header} gutter={gutter} styles={styles} />,
            },
          ]
        : gap(shown.hunks[i - 1]?.end ?? 0, hunk.start)),
      ...hunkRows(hunk, marks[i], rows),
    ]),
    ...(whole == null || shown.cut || last == null ? [] : gap(last.end, whole.length)),
  ];
  const windowed = (
    <WindowedRows key={`${sideways}:${view.hideWhitespace}`} rows={body} sideways={sideways} minWidth={visibleWidth ?? 0} />
  );
  return (
    <>
      <View>
        {sideways ? (
          <AnimatedScrollView
            horizontal
            keyboardShouldPersistTaps="handled"
            onLayout={(event) => setVisibleWidth(event.nativeEvent.layout.width)}
            onScroll={onScrollX}
            scrollEventThrottle={16}
          >
            {windowed}
          </AnimatedScrollView>
        ) : (
          windowed
        )}
        {shown.cut ? (
          <ShowMoreChanges theme={theme} hidden={hidden} onPress={onShowMore} />
        ) : null}
      </View>
      <UnplacedCards theme={theme} block={block} cards={unplaced} comments={comments} />
    </>
  );
}

function GapRow({
  from,
  to,
  total,
  gutter,
  theme,
  styles,
  onReveal,
}: {
  from: number;
  to: number;
  total: number;
  gutter: number;
  theme: PluginTheme;
  styles: DiffStyles;
  onReveal(range: Range): void;
}) {
  const hidden = to - from;
  if (hidden <= 0) return null;
  const color = theme.colors.foregroundMuted;
  const step = hidden > EXPAND_STEP;
  const button = (label: string, icon: string, range: Range) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={6} onPress={() => onReveal(range)}>
      <Icon name={icon} size={14} color={color} />
    </Pressable>
  );
  return (
    <View style={[styles.row, styles.gap]} dataSet={CODE_SURFACE}>
      <View style={[styles.gapButtons, { width: gutter }]}>
        {step && to < total ? button(`Show ${EXPAND_STEP} lines above`, "ChevronUp", [to - EXPAND_STEP, to]) : null}
        {step && from > 0 ? button(`Show ${EXPAND_STEP} lines below`, "ChevronDown", [from, from + EXPAND_STEP]) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={hidden > MAX_REVEAL_ALL}
        style={styles.gapLabel}
        onPress={() => onReveal([from, to])}
      >
        <Icon name="ChevronsUpDown" size={12} color={color} />
        <Text style={styles.mutedCode}>
          {hidden === 1 ? "1 hidden line" : `${hidden} hidden lines`}
        </Text>
      </Pressable>
    </View>
  );
}

function scrollsSideways(view: ViewOptions): boolean {
  return view.layout === "unified" && !view.wrapLines;
}

interface RowProps {
  readonly file: DiffFile;
  readonly gutter: number;
  readonly view: ViewOptions;
  readonly styles: DiffStyles;
  readonly syntax: FileSyntax | null;
  readonly palette: SyntaxPalette | null;
  readonly cards: readonly Card[];
  readonly comments: FileComments;
  readonly slot: (card: Card) => ReactNode;
}

function hunkRows(
  hunk: ShownHunk,
  marks: ReadonlyMap<DiffLine, readonly Span[]>,
  { file, gutter, view, styles, syntax, palette, cards, comments, slot }: RowProps,
): WindowedRow[] {
  const { lines } = hunk;
  const scope = draftScope(file, comments.draft, [lines]);
  const positions = new Map(lines.map((line, i) => [line, i]));
  const indexOf = (line: DiffLine) => positions.get(line) ?? -1;
  const cardsByLine = new Map<number, Card[]>();
  for (const card of cards) {
    const index = cardLine(card, lines);
    if (index < 0) continue;
    const here = cardsByLine.get(index);
    if (here == null) cardsByLine.set(index, [card]);
    else here.push(card);
  }
  const cardsAt = (index: number) => cardsByLine.get(index) ?? [];
  const holdsDraft = (indexes: readonly number[]) =>
    indexes.some((index) => cardsAt(index).some((card) => card.kind !== "saved"));
  const gutterFor = (line: DiffLine) => {
    const index = indexOf(line);
    return {
      onPress: () => comments.compose(lines, index, index),
      onLongPress: () => comments.compose(lines, index, index, true),
    };
  };
  const cell = { styles, syntax, palette, marks };
  const covers = (line: DiffLine | null, side: CommentTarget["side"]) =>
    line != null && scope?.side === side && inScope(scope, line);
  return view.layout === "split" ? splitBody() : unifiedBody();

  function splitBody(): WindowedRow[] {
    const rows = splitRows(lines);
    const oldEdges = scopeEdges(rows, (row) => covers(row.left, "old"));
    const newEdges = scopeEdges(rows, (row) => covers(row.right, "new"));
    return rows.map((row, i) => {
      const indexes = [...new Set([row.left, row.right].flatMap((line) => (line == null ? [] : [indexOf(line)])))];
      return {
        key: `${lineKey(row.left)}|${lineKey(row.right)}`,
        pinned: holdsDraft(indexes),
        estimate: CODE_LINE_HEIGHT,
        render: () => (
          <>
            <SplitLineRow row={row} gutter={gutter} gutterFor={gutterFor} edges={[oldEdges[i], newEdges[i]]} {...cell} />
            {indexes.flatMap(cardsAt).map(slot)}
          </>
        ),
      };
    });
  }

  function unifiedBody(): WindowedRow[] {
    const edges = scopeEdges(lines, (line) => scope != null && inScope(scope, line));
    return lines.map((line, i) => ({
      key: lineKey(line),
      pinned: holdsDraft([i]),
      estimate: CODE_LINE_HEIGHT,
      render: () => (
        <>
          <LineRow line={line} gutter={gutter} wrap={!scrollsSideways(view)} press={gutterFor(line)} edge={edges[i]} {...cell} />
          {cardsAt(i).map(slot)}
        </>
      ),
    }));
  }
}

// By line, not index: an open comment box keeps its text as revealed context shifts and merges hunks.
function lineKey(line: DiffLine | null): string {
  return line == null ? "" : `${line.oldNumber ?? ""}:${line.newNumber ?? ""}`;
}

interface GutterPress {
  onPress(): void;
  onLongPress(): void;
}

interface CellProps {
  readonly styles: DiffStyles;
  readonly syntax: FileSyntax | null;
  readonly palette: SyntaxPalette | null;
  /** The changed words of the lines that have them. */
  readonly marks: ReadonlyMap<DiffLine, readonly Span[]>;
}

function LineRow({
  line,
  gutter,
  wrap,
  press,
  edge,
  ...cell
}: CellProps & { line: DiffLine; gutter: number; wrap: boolean; press: GutterPress; edge: ScopeEdge }) {
  const { styles } = cell;
  const look = lineLook(line, styles);
  return (
    <>
      <View style={look.row} dataSet={CODE_SURFACE}>
        <ScopeMark edge={edge} styles={styles} />
        <LineNumber
          number={line.kind === "del" ? line.oldNumber : line.newNumber}
          gutter={gutter}
          style={look.number}
          press={press}
        />
        <Text style={wrap ? styles.code : styles.codeSideways} selectable>
          {codeContent(line, cell)}
        </Text>
      </View>
      {line.noNewlineMarker == null ? null : (
        <MutedRow text={line.noNewlineMarker.slice(2)} gutter={gutter} styles={styles} />
      )}
    </>
  );
}

function SplitLineRow({
  row,
  gutter,
  gutterFor,
  edges: [oldEdge, newEdge],
  ...cell
}: CellProps & {
  row: SplitRow;
  gutter: number;
  gutterFor(line: DiffLine): GutterPress;
  edges: readonly [ScopeEdge, ScopeEdge];
}) {
  return (
    <View style={cell.styles.row} dataSet={CODE_SURFACE}>
      <SplitCell
        line={row.left}
        number={row.left?.oldNumber ?? null}
        gutter={gutter}
        gutterFor={gutterFor}
        edge={oldEdge}
        {...cell}
      />
      <View style={cell.styles.splitDivider} />
      <SplitCell
        line={row.right}
        number={row.right?.newNumber ?? null}
        gutter={gutter}
        gutterFor={gutterFor}
        edge={newEdge}
        {...cell}
      />
    </View>
  );
}

function SplitCell({
  line,
  number,
  gutter,
  gutterFor,
  edge,
  ...cell
}: CellProps & {
  line: DiffLine | null;
  number: number | null;
  gutter: number;
  gutterFor(line: DiffLine): GutterPress;
  edge: ScopeEdge;
}) {
  const { styles } = cell;
  if (line == null) {
    return (
      <View style={styles.splitCell}>
        <ScopeMark edge={edge} styles={styles} />
      </View>
    );
  }
  const look = lineLook(line, styles);
  return (
    <View style={[styles.splitCell, look.row]}>
      <ScopeMark edge={edge} styles={styles} />
      <LineNumber number={number} gutter={gutter} style={look.number} press={gutterFor(line)} />
      <Text style={styles.code} selectable>
        {codeContent(line, cell)}
      </Text>
    </View>
  );
}

function ScopeMark({ edge, styles }: { edge: ScopeEdge; styles: DiffStyles }) {
  if (edge == null) return null;
  return <View pointerEvents="none" style={[styles.inScope, edge.first && styles.inScopeFirst, edge.last && styles.inScopeLast]} />;
}

/** Tap to comment on the line; long-press to stretch an open comment to it. */
function LineNumber({
  number,
  gutter,
  style,
  press,
}: {
  number: number | null;
  gutter: number;
  style: DiffStyles["number"];
  press: GutterPress;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={number == null ? "Comment on this line" : `Comment on line ${number}`}
      onPress={press.onPress}
      onLongPress={press.onLongPress}
    >
      <Text style={[style, { width: gutter }]}>{number}</Text>
    </Pressable>
  );
}

function codeContent(line: DiffLine, { syntax, palette, marks, styles }: CellProps): ReactNode {
  const tokens = lineTokens(syntax, palette, line);
  const spans = marks.get(line);
  if (tokens == null && spans == null) return expandTabs(line.text);
  const mark = line.kind === "add" ? styles.addMark : styles.delMark;
  return markedPieces(tokens ?? [{ text: line.text, color: null }], spans ?? []).map((piece, i) => (
    <Text key={i} style={[piece.color == null ? undefined : { color: piece.color }, piece.marked && mark]}>
      {expandTabs(piece.text)}
    </Text>
  ));
}

function markedPieces(tokens: readonly ColoredText[], spans: readonly Span[]): (ColoredText & { marked: boolean })[] {
  const pieces: (ColoredText & { marked: boolean })[] = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + token.text.length;
    const cuts = [offset, ...spans.flatMap(({ start, end: stop }) => [start, stop]).filter((at) => at > offset && at < end), end];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const text = token.text.slice(cuts[i] - offset, cuts[i + 1] - offset);
      const marked = spans.some(({ start, end: stop }) => cuts[i] >= start && cuts[i] < stop);
      if (text !== "") pieces.push({ text, color: token.color, marked });
    }
    offset = end;
  }
  return pieces;
}

function MutedRow({ text, gutter, styles }: { text: string; gutter: number; styles: DiffStyles }) {
  return (
    <View style={styles.row} dataSet={CODE_SURFACE}>
      <Text style={[styles.number, { width: gutter }]} />
      <Text style={styles.mutedCode} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

function lineLook(line: DiffLine, styles: DiffStyles): { row: DiffStyles["row"]; number: DiffStyles["number"] } {
  if (line.kind === "add") return { row: styles.addRow, number: styles.addNumber };
  if (line.kind === "del") return { row: styles.delRow, number: styles.delNumber };
  return { row: styles.row, number: styles.number };
}

function expandTabs(text: string): string {
  return text.replace(/\t/g, "    ");
}

function gutterWidth(file: DiffFile): number {
  let largest = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      largest = Math.max(largest, line.oldNumber ?? 0, line.newNumber ?? 0);
    }
  }
  return Math.max(2, String(largest).length) * Math.ceil(CODE_FONT_SIZE * 0.62) + 12;
}
