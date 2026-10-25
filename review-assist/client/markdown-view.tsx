import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useMemo, useRef, useState } from "react";
import {
  type GestureResponderEvent,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
} from "react-native";
import { messageOf } from "../shared/errors";
import type { FileBlock } from "../shared/guide";
import { hashText } from "../shared/hash";
import {
  type MarkdownBlock,
  type MarkdownEntry,
  type MarkdownOutcome,
  type MarkdownRun,
  markdownRpc,
} from "../shared/protocol";
import { type BlockSides, type SideLine, blockSides } from "../shared/sides";
import {
  type Card,
  CommentSlot,
  type FileComments,
  UnplacedCards,
  cardKey,
  cardLine,
  draftScope,
  fileCards,
  inScope,
} from "./comments";
import { IN_SCOPE_ALPHA, MONOSPACE, diffAlpha, tint } from "./palette";
import type { FileText } from "./use-code";
import { hasMouse } from "./web";

const CONTEXT_BLOCKS = 2;
const HEADING_SIZES = [24, 20, 17, 15, 14, 13];
const LIST_INDENT = 22;
const THIN_SPACE = String.fromCharCode(0x2009);

type Row =
  | { readonly kind: "entry"; readonly entry: MarkdownEntry; readonly index: number }
  | { readonly kind: "hidden"; readonly count: number; readonly run: number };

type MarkdownStyles = ReturnType<typeof createStyles>;

export function MarkdownBody({
  block,
  text,
  theme,
  comments,
  noteStyle,
  fallback,
}: {
  block: FileBlock;
  text: FileText;
  theme: PluginTheme;
  comments: FileComments;
  noteStyle: TextStyle;
  fallback: ReactNode;
}) {
  // The file's previous text, standing in while its new one loads, doesn't match the new hunks.
  const current = text.status === "ready" && !text.previous ? text.text : null;
  const sides = useMemo(() => (current == null ? null : blockSides(block, current, false)), [block, current]);
  const { outcome, pending } = useMarkdownDiff(sides?.original.text ?? null, sides?.modified.text ?? null);
  // Entries, and an open comment, index the sides they came from: the last matching pair stays while the next loads.
  const shown = useRef<{ sides: BlockSides; entries: readonly MarkdownEntry[] } | null>(null);
  if (sides != null && outcome?.status === "ready" && !pending) shown.current = { sides, entries: outcome.entries };
  const reason = text.status === "failed" ? text.error : outcome?.status === "unavailable" ? outcome.reason : null;
  if (reason != null) {
    return (
      <>
        <Text style={noteStyle}>{reason}</Text>
        {fallback}
      </>
    );
  }
  if (shown.current == null) return <Text style={noteStyle}>Rendering the markdown…</Text>;
  return (
    <MarkdownEntries
      theme={theme}
      block={block}
      sides={shown.current.sides}
      entries={shown.current.entries}
      comments={comments}
    />
  );
}

function useMarkdownDiff(
  before: string | null,
  after: string | null,
): { outcome: MarkdownOutcome | null; pending: boolean } {
  const diff = useRpc(markdownRpc);
  const hashes = useMemo(() => [hashText(before ?? ""), hashText(after ?? "")], [before, after]);
  const query = useQuery({
    queryKey: ["review-markdown", ...hashes],
    queryFn: () => diff({ before: before ?? "", after: after ?? "" }),
    enabled: before != null && after != null,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const pending = query.isPlaceholderData;
  if (query.data != null) return { outcome: query.data, pending };
  return { outcome: query.error == null ? null : { status: "unavailable", reason: messageOf(query.error) }, pending };
}

function MarkdownEntries({
  theme,
  block,
  sides,
  entries,
  comments,
}: {
  theme: PluginTheme;
  block: FileBlock;
  sides: BlockSides;
  entries: readonly MarkdownEntry[];
  comments: FileComments;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const placement = useMemo(() => placeCards(fileCards(comments), entries, sides), [comments, entries, sides]);
  const scope = draftScope(block.file, comments.draft, [sides.original.lines, sides.modified.lines]);
  const covered = (entry: MarkdownEntry) =>
    scope != null &&
    entry.lines != null &&
    sideLines(sides, entry.lines.side)
      .slice(entry.lines.start, entry.lines.end + 1)
      .some((line) => inScope(scope, line));
  const compose = (entry: MarkdownEntry) => {
    const at = entry.lines;
    if (at == null) return null;
    return (extend: boolean) => comments.compose(sideLines(sides, at.side), at.start, at.end, extend);
  };
  return (
    <View style={styles.document}>
      {rowsOf(entries, expanded, placement.byEntry).map((row) =>
        row.kind === "entry" ? (
          <Fragment key={row.index}>
            <EntryView
              theme={theme}
              styles={styles}
              entry={row.entry}
              covered={covered(row.entry)}
              onCompose={compose(row.entry)}
            />
            {(placement.byEntry.get(row.index) ?? []).map((card) => (
              <CommentSlot key={cardKey(card)} theme={theme} file={block.file} card={card} comments={comments} />
            ))}
          </Fragment>
        ) : (
          <Pressable
            key={`hidden:${row.run}`}
            accessibilityRole="button"
            style={styles.hidden}
            onPress={() => setExpanded((runs) => new Set(runs).add(row.run))}
          >
            <Icon name="ChevronsUpDown" size={12} color={theme.colors.foregroundMuted} />
            <Text style={styles.hiddenLabel}>
              {row.count === 1 ? "1 unchanged block" : `${row.count} unchanged blocks`}
            </Text>
          </Pressable>
        ),
      )}
      <UnplacedCards theme={theme} block={block} cards={placement.unplaced} comments={comments} />
    </View>
  );
}

function sideLines(sides: BlockSides, side: "old" | "new"): readonly SideLine[] {
  return side === "new" ? sides.modified.lines : sides.original.lines;
}

/** Each card under the block holding its line, or the nearest block above it. */
function placeCards(
  cards: readonly Card[],
  entries: readonly MarkdownEntry[],
  sides: BlockSides,
): { byEntry: ReadonlyMap<number, Card[]>; unplaced: Card[] } {
  const byEntry = new Map<number, Card[]>();
  const unplaced: Card[] = [];
  const above = (line: number, side: "old" | "new") =>
    entries.findLastIndex((entry) => entry.lines?.side === side && entry.lines.start <= line);
  for (const card of cards) {
    const index = entryFor(card);
    if (index < 0) unplaced.push(card);
    else byEntry.set(index, [...(byEntry.get(index) ?? []), card]);
  }
  return { byEntry, unplaced };

  function entryFor(card: Card): number {
    const onNew = cardLine(card, sides.modified.lines);
    if (onNew >= 0) return above(onNew, "new");
    const onOld = cardLine(card, sides.original.lines);
    if (onOld < 0) return -1;
    const removed = above(onOld, "old");
    if (removed >= 0 && (entries[removed].lines?.end ?? -1) >= onOld) return removed;
    // A removed line of an edited block: the block is the one above where the new text resumes.
    const resumes = sides.original.lines.slice(onOld).find(({ newNumber }) => newNumber != null)?.newNumber;
    const next = sides.modified.lines.findIndex(({ newNumber }) => resumes != null && newNumber === resumes);
    return above((next < 0 ? sides.modified.lines.length : next) - 1, "new");
  }
}

/** Long runs of unchanged blocks folded down to the few beside each change, until expanded or commented on. */
function rowsOf(
  entries: readonly MarkdownEntry[],
  expanded: ReadonlySet<number>,
  pinned: ReadonlyMap<number, unknown>,
): Row[] {
  const rows: Row[] = [];
  const show = (from: number, to: number) => {
    for (let index = from; index < to; index++) rows.push({ kind: "entry", entry: entries[index], index });
  };
  let start = 0;
  while (start < entries.length) {
    let end = start + 1;
    const same = entries[start].change === "same";
    while (same && end < entries.length && entries[end].change === "same") end++;
    const hideFrom = start === 0 ? 0 : start + CONTEXT_BLOCKS;
    const hideTo = end === entries.length ? end : end - CONTEXT_BLOCKS;
    const isPinned = [...pinned.keys()].some((index) => index >= hideFrom && index < hideTo);
    if (!same || hideTo - hideFrom < 2 || expanded.has(start) || isPinned) {
      show(start, end);
    } else {
      show(start, hideFrom);
      rows.push({ kind: "hidden", count: hideTo - hideFrom, run: start });
      show(hideTo, end);
    }
    start = end;
  }
  return rows;
}

function EntryView({
  theme,
  styles,
  entry,
  covered,
  onCompose,
}: {
  theme: PluginTheme;
  styles: MarkdownStyles;
  entry: MarkdownEntry;
  covered: boolean;
  /** Null for a block whose lines weren't found, which has nowhere to anchor a comment. */
  onCompose: ((extend: boolean) => void) | null;
}) {
  const { colors } = theme;
  const { change, quote, list, block } = entry;
  const [blockHovered, setBlockHovered] = useState(false);
  const [buttonHovered, setButtonHovered] = useState(false);
  const [buttonFocused, setButtonFocused] = useState(false);
  const showAdd = blockHovered || buttonHovered || buttonFocused || covered;
  const mouse = hasMouse();
  const bar =
    change === "added"
      ? colors.statusSuccess
      : change === "removed"
        ? colors.statusDanger
        : change === "changed"
          ? colors.statusWarning
          : "transparent";
  const fill = change === "added" || change === "removed" ? changeTint(theme, change, "block") : undefined;
  let body = (
    <View style={[styles.item, { paddingLeft: list == null ? 0 : (list.depth - 1) * LIST_INDENT }]}>
      {list == null ? null : <Text style={styles.marker}>{list.marker ?? ""}</Text>}
      <View style={styles.fill}>
        <BlockView theme={theme} styles={styles} block={block} />
      </View>
    </View>
  );
  for (let level = 0; level < quote; level++) body = <View style={styles.quote}>{body}</View>;
  const background = covered ? tint(colors.accent, IN_SCOPE_ALPHA.fill) : fill;
  return (
    <Pressable
      disabled={onCompose == null}
      focusable={!mouse}
      onHoverIn={() => setBlockHovered(true)}
      onHoverOut={() => setBlockHovered(false)}
      onPress={mouse ? undefined : () => onCompose?.(false)}
      onLongPress={mouse ? undefined : () => onCompose?.(true)}
      style={[
        styles.entry,
        { borderLeftColor: bar, backgroundColor: background },
        mouse && styles.plainCursor,
      ]}
    >
      <View style={styles.gutter}>
        {mouse && onCompose != null ? (
          // Kept mounted while hidden: rendered only on hover, it missed clicks.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Comment on this block"
            onHoverIn={() => setButtonHovered(true)}
            onHoverOut={() => setButtonHovered(false)}
            onFocus={() => setButtonFocused(true)}
            onBlur={() => setButtonFocused(false)}
            onPress={(event) => onCompose(widens(event))}
            style={[styles.add, { backgroundColor: colors.accent, opacity: showAdd ? 1 : 0 }]}
          >
            <Icon name="Plus" size={12} color={colors.accentForeground} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.fill}>{body}</View>
    </Pressable>
  );
}

function widens(event: GestureResponderEvent): boolean {
  const native = event.nativeEvent;
  return "shiftKey" in native && native.shiftKey === true;
}

/** Whole blocks and columns take the lighter tint, lines, rows and words the stronger one. */
function changeTint(
  theme: PluginTheme,
  change: "added" | "removed" | null,
  strength: "block" | "mark",
): string | undefined {
  if (change == null) return undefined;
  const alpha = diffAlpha(theme);
  return change === "added"
    ? tint(theme.colors.statusSuccess, strength === "block" ? alpha.addLine : alpha.addMark)
    : tint(theme.colors.statusDanger, strength === "block" ? alpha.delLine : alpha.delMark);
}

function BlockView({ theme, styles, block }: { theme: PluginTheme; styles: MarkdownStyles; block: MarkdownBlock }) {
  switch (block.kind) {
    case "heading": {
      const fontSize = HEADING_SIZES[Math.min(block.depth, HEADING_SIZES.length) - 1];
      const size = { fontSize, lineHeight: Math.round(fontSize * 1.35) };
      return <Runs theme={theme} style={[styles.heading, size]} runs={block.runs} />;
    }
    case "text":
      return <Runs theme={theme} style={styles.text} runs={block.runs} />;
    case "code":
      return (
        <View style={styles.code}>
          {block.lines.map((line, index) => (
            <Text
              key={index}
              style={[
                styles.codeLine,
                { backgroundColor: changeTint(theme, line.change, "mark") },
                line.change === "removed" && styles.struck,
              ]}
            >
              {line.text === "" ? " " : line.text}
            </Text>
          ))}
        </View>
      );
    case "table":
      return (
        <View style={styles.table}>
          {block.rows.map((row, rowIndex) => (
            <View key={rowIndex} style={[styles.tableRow, { backgroundColor: changeTint(theme, row.change, "mark") }]}>
              {row.cells.map((cell, cellIndex) => {
                const column = block.columns[cellIndex];
                const columnTint = changeTint(theme, column?.change ?? null, "block");
                return (
                  <View key={cellIndex} style={[styles.cell, { backgroundColor: columnTint }]}>
                    <Runs
                      theme={theme}
                      style={[
                        styles.text,
                        row.header && styles.strong,
                        { textAlign: column?.align ?? "left" },
                        (row.change === "removed" || column?.change === "removed") && styles.struck,
                      ]}
                      runs={cell}
                    />
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      );
    case "rule":
      return <View style={styles.rule} />;
  }
}

function Runs({
  theme,
  style,
  runs,
}: {
  theme: PluginTheme;
  style: StyleProp<TextStyle>;
  runs: readonly MarkdownRun[];
}) {
  const { colors } = theme;
  return (
    <Text style={style}>
      {runs.length === 0
        ? " "
        : runs.map((run, index) => (
            <Fragment key={index}>
              {run.change === "added" && runs[index - 1]?.change === "removed" ? THIN_SPACE : null}
              <Text
                style={{
                  fontWeight: run.strong ? "700" : undefined,
                  fontStyle: run.em || run.image ? "italic" : undefined,
                  fontFamily: run.code ? MONOSPACE : undefined,
                  color: run.image ? colors.foregroundMuted : run.href != null ? colors.accent : undefined,
                  textDecorationLine: run.strike || run.change === "removed" ? "line-through" : undefined,
                  backgroundColor:
                    changeTint(theme, run.change, "mark") ?? (run.code ? colors.surface2 : undefined),
                }}
              >
                {run.image ? `(image: ${run.text})` : run.text}
              </Text>
            </Fragment>
          ))}
    </Text>
  );
}

function createStyles(theme: PluginTheme) {
  const { colors } = theme;
  return StyleSheet.create({
    document: { paddingVertical: 8 },
    entry: { flexDirection: "row", borderLeftWidth: 3, paddingRight: 16, paddingVertical: 4 },
    plainCursor: { cursor: "auto" },
    gutter: { width: 24, alignItems: "center", paddingTop: 2 },
    add: { width: 16, height: 16, borderRadius: 4, alignItems: "center", justifyContent: "center" },
    item: { flexDirection: "row" },
    marker: { width: LIST_INDENT, fontSize: 14, lineHeight: 21, color: colors.foregroundMuted },
    fill: { flex: 1, minWidth: 0 },
    quote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 10 },
    heading: { fontWeight: "600", color: colors.foreground, marginTop: 4 },
    text: { fontSize: 14, lineHeight: 21, color: colors.foreground },
    strong: { fontWeight: "700" },
    struck: { textDecorationLine: "line-through" },
    code: { backgroundColor: colors.surface1, borderRadius: 6, paddingVertical: 6, overflow: "hidden" },
    codeLine: { fontFamily: MONOSPACE, fontSize: 12, lineHeight: 18, paddingHorizontal: 10, color: colors.foreground },
    table: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 4, overflow: "hidden" },
    tableRow: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    cell: { flex: 1, minWidth: 0, paddingHorizontal: 8, paddingVertical: 4 },
    rule: { height: 1, backgroundColor: colors.border, marginVertical: 10 },
    hidden: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 6 },
    hiddenLabel: { fontSize: 12, color: colors.foregroundMuted },
  });
}
