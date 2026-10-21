import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type FlatList as NativeFlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { CommentTarget } from "../shared/comments";
import { type DiffFile, type DiffLine, isChange } from "../shared/diff";
import { type SplitRow, splitRows } from "../shared/display";
import { type FileBlock, blockCounts } from "../shared/guide";
import type { DraftComment } from "../shared/protocol";
import type { ViewOptions } from "../shared/settings";
import { type ShownHunk, type SideLine, blockHunks } from "../shared/sides";
import {
  type Card,
  type CommentDraft,
  CommentSlot,
  type FileComments,
  UnplacedCards,
  cardKey,
  cardLine,
  fileCards,
} from "./comments";
import { BinaryBody } from "./binary-view";
import { ChangeStats, FileLabel } from "./controls";
import { MonacoFileDiff, estimateHeight } from "./monaco-diff";
import type { CodeSource } from "./monaco/review-monaco";
import type { SyntaxPalette } from "./monaco/theme";
import { CODE_SURFACE, MONOSPACE, tint } from "./palette";
import { type FileSyntax, lineTokens } from "./syntax";
import { useFileText, usePalette, useSyntax } from "./use-code";
import { isMonacoSupported } from "./web";

const COLLAPSE_OVER_LINES = 800;
const MAX_SCROLL_ATTEMPTS = 60;
const CODE_FONT_SIZE = 12;
const CODE_LINE_HEIGHT = 18;
const NO_COMMENTS: readonly DraftComment[] = [];

export interface ScrollTarget {
  readonly blockIndex: number;
  readonly nonce: number;
}

/** "Collapse all" or "Expand all"; a new nonce re-applies it over files toggled since. */
export interface FoldCommand {
  readonly collapsed: boolean;
  readonly nonce: number;
}

export interface FileViewing {
  isViewed(block: FileBlock): boolean;
  setViewed(block: FileBlock, viewed: boolean): void;
}

export interface CommentStore {
  readonly comments: readonly DraftComment[];
  save(comment: DraftComment): void;
  remove(id: string): void;
}

interface CommentActions {
  compose(filePath: string, lines: readonly SideLine[], start: number, end: number, extend: boolean): void;
  edit(comment: DraftComment): void;
  cancel(): void;
  submit(target: CommentTarget, body: string): void;
  remove(id: string): void;
}

interface DiffListProps {
  readonly blocks: readonly FileBlock[];
  readonly source: CodeSource;
  readonly theme: PluginTheme;
  readonly view: ViewOptions;
  readonly target: ScrollTarget | null;
  readonly fold: FoldCommand | null;
  readonly comments: CommentStore;
  /** Gives each file header a "Viewed" checkbox; viewed files start collapsed. */
  readonly viewed?: FileViewing;
  readonly header?: ReactElement;
  readonly footer?: ReactElement;
}

interface Folding {
  /** Every file's state, or null for the default: viewed, generated and very long files collapsed. */
  readonly base: boolean | null;
  /** Collapsed state set on one file since, by its header or its Viewed checkbox. */
  readonly overrides: ReadonlyMap<string, boolean>;
}

type DiffStyles = ReturnType<typeof createStyles>;

export function DiffList(props: DiffListProps) {
  const { blocks, source, theme, view, target, fold, viewed, header, footer } = props;
  const list = useRef<NativeFlatList<FileBlock>>(null);
  const attempts = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [folding, setFolding] = useState<Folding>(() => ({ base: fold?.collapsed ?? null, overrides: new Map() }));
  const styles = useMemo(() => createStyles(theme), [theme]);
  const palette = usePalette(theme);
  const [overflowHost, setOverflowHost] = useState<object | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const latest = useRef({ props, draft });
  latest.current = { props, draft };

  const setCollapsed = useCallback((path: string, collapsed: boolean) => {
    setFolding(({ base, overrides }) => ({ base, overrides: new Map(overrides).set(path, collapsed) }));
  }, []);

  const markViewed = useCallback(
    (block: FileBlock, isViewed: boolean) => {
      setCollapsed(block.file.path, isViewed);
      latest.current.props.viewed?.setViewed(block, isViewed);
    },
    [setCollapsed],
  );

  const actions = useMemo(
    (): CommentActions => ({
      compose: (filePath, lines, start, end, extend) =>
        setDraft((current) =>
          extend && current?.kind === "new" && current.lines === lines
            ? { ...current, start: Math.min(current.start, start), end: Math.max(current.end, end) }
            : { kind: "new", filePath, lines, start, end },
        ),
      edit: (comment) => setDraft({ kind: "edit", comment }),
      cancel: () => setDraft(null),
      submit: (target, body) => {
        const { draft: current, props: currentProps } = latest.current;
        currentProps.comments.save(
          current?.kind === "edit"
            ? { ...current.comment, body }
            : { ...target, id: newCommentId(), body, createdAt: new Date().toISOString() },
        );
        setDraft(null);
      },
      remove: (id) => {
        latest.current.props.comments.remove(id);
        setDraft((current) => (current?.kind === "edit" && current.comment.id === id ? null : current));
      },
    }),
    [],
  );

  const commentsByFile = useMemo(() => {
    const byFile = new Map<string, DraftComment[]>();
    for (const comment of props.comments.comments) {
      const existing = byFile.get(comment.filePath);
      if (existing == null) byFile.set(comment.filePath, [comment]);
      else existing.push(comment);
    }
    return byFile;
  }, [props.comments.comments]);
  const extraData = useMemo(
    () => [folding, viewed, commentsByFile, draft, palette],
    [folding, viewed, commentsByFile, draft, palette],
  );

  useEffect(() => {
    if (fold != null) setFolding({ base: fold.collapsed, overrides: new Map() });
  }, [fold]);

  const scrolledTo = useRef<number | null>(null);
  useEffect(() => {
    if (target == null || target.blockIndex >= blocks.length || scrolledTo.current === target.nonce) return;
    scrolledTo.current = target.nonce;
    attempts.current = 0;
    list.current?.scrollToIndex({ index: target.blockIndex, animated: false });
    return () => clearTimeout(retry.current);
  }, [target, blocks.length]);

  return (
    <View style={styles.list}>
      <FlatList
        ref={list}
        style={styles.list}
        data={blocks}
        extraData={extraData}
        keyExtractor={(block, index) => `${block.file.index}:${index}`}
        initialNumToRender={4}
        windowSize={7}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        onScrollToIndexFailed={({ index, highestMeasuredFrameIndex }) => {
          // Rows vary in height, so the target has no offset until rendered: bring the end of the
          // furthest measured row into view, which renders the rows after it, and aim again.
          list.current?.scrollToIndex({ index: highestMeasuredFrameIndex, viewPosition: 1, animated: false });
          clearTimeout(retry.current);
          if (attempts.current++ < MAX_SCROLL_ATTEMPTS) {
            retry.current = setTimeout(() => list.current?.scrollToIndex({ index, animated: false }), 50);
          }
        }}
        renderItem={({ item }) => {
          const isViewed = viewed?.isViewed(item) ?? null;
          const collapsed =
            folding.overrides.get(item.file.path) ??
            folding.base ??
            (isViewed === true || collapsedByDefault(item));
          return (
            <FileBlockView
              block={item}
              source={source}
              overflowHost={overflowHost}
              collapsed={collapsed}
              viewed={isViewed}
              comments={commentsByFile.get(item.file.path) ?? NO_COMMENTS}
              draft={draft != null && draftPath(draft) === item.file.path ? draft : null}
              actions={actions}
              onCollapse={setCollapsed}
              onViewed={markViewed}
              view={view}
              styles={styles}
              theme={theme}
              palette={palette}
            />
          );
        }}
      />
      {isMonacoSupported() ? (
        <View ref={(node) => setOverflowHost(node)} style={styles.overflowHost} dataSet={CODE_SURFACE} />
      ) : null}
    </View>
  );
}

function draftPath(draft: CommentDraft): string {
  return draft.kind === "edit" ? draft.comment.filePath : draft.filePath;
}

function newCommentId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function collapsedByDefault(block: FileBlock): boolean {
  return block.file.generated || lineCount(block) > COLLAPSE_OVER_LINES;
}

function lineCount(block: FileBlock): number {
  return block.chunks.reduce((sum, chunk) => sum + chunk.end - chunk.start, 0);
}

interface FileBlockViewProps {
  readonly block: FileBlock;
  readonly source: CodeSource;
  readonly overflowHost: object | null;
  readonly collapsed: boolean;
  /** Null hides the checkbox. */
  readonly viewed: boolean | null;
  readonly comments: readonly DraftComment[];
  readonly draft: CommentDraft | null;
  readonly actions: CommentActions;
  readonly onCollapse: (path: string, collapsed: boolean) => void;
  readonly onViewed: (block: FileBlock, viewed: boolean) => void;
  readonly view: ViewOptions;
  readonly styles: DiffStyles;
  readonly theme: PluginTheme;
  readonly palette: SyntaxPalette | null;
}

const FileBlockView = memo(function FileBlockView({
  block,
  source,
  overflowHost,
  collapsed,
  viewed,
  comments,
  draft,
  actions,
  onCollapse,
  onViewed,
  view,
  styles,
  theme,
  palette,
}: FileBlockViewProps) {
  const { file } = block;
  const moved = file.oldPath != null && file.oldPath !== file.path;
  const hasText = file.hunks.length > 0 && !file.binary;
  const monaco = hasText && overflowHost != null && palette != null;
  const text = useFileText(source, file, monaco && !collapsed);
  // New hunks laid over the file's previous text misplace lines: keep the last pair that agrees.
  const lastMatched = useRef<{ block: FileBlock; text: string } | null>(null);
  if (text.status === "ready" && !text.previous) lastMatched.current = { block, text: text.text };
  const matched = text.status !== "ready" ? null : text.previous ? lastMatched.current : { block, text: text.text };
  const fileComments = useMemo(
    (): FileComments => ({
      comments,
      draft,
      compose: (lines, start, end, extend = false) => actions.compose(file.path, lines, start, end, extend),
      edit: actions.edit,
      cancel: actions.cancel,
      submit: actions.submit,
      remove: actions.remove,
    }),
    [comments, draft, actions, file.path],
  );
  const onlyWhitespace = useMemo(
    () =>
      view.hideWhitespace &&
      block.chunks.some(({ hunk, start, end }) => hunk.lines.slice(start, end).some(isChange)) &&
      blockHunks(block, true).length === 0,
    [block, view.hideWhitespace],
  );
  const nativeBody = (
    <NativeBody block={block} source={source} view={view} styles={styles} theme={theme} palette={palette} comments={fileComments} />
  );

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${file.path}`}
        accessibilityState={{ expanded: !collapsed }}
        style={({ pressed }) => [styles.fileHeader, pressed && styles.fileHeaderPressed]}
        onPress={() => onCollapse(file.path, !collapsed)}
      >
        <FileLabel theme={theme} path={file.path} detail={moved ? `from ${file.oldPath}` : undefined} />
        {comments.length === 0 ? null : (
          <View style={styles.commentCount} accessibilityLabel={`${comments.length} unsent ${comments.length === 1 ? "comment" : "comments"}`}>
            <Icon name="MessageSquare" size={12} color={theme.colors.foregroundMuted} />
            <Text style={styles.viewedLabel}>{comments.length}</Text>
          </View>
        )}
        <ChangeStats theme={theme} file={file} {...blockCounts(block)} />
        {viewed == null ? null : (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={`Viewed ${file.path}`}
            aria-checked={viewed}
            hitSlop={6}
            onPress={() => onViewed(block, !viewed)}
            style={({ pressed }) => [styles.viewedToggle, pressed && styles.fileHeaderPressed]}
          >
            <Icon
              name={viewed ? "SquareCheck" : "Square"}
              size={14}
              color={viewed ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
            />
            <Text style={styles.viewedLabel}>Viewed</Text>
          </Pressable>
        )}
      </Pressable>
      {collapsed ? null : (
        <View style={styles.body}>
          {fileNotes(file).map((note) => (
            <Text key={note} style={styles.note}>
              {note}
            </Text>
          ))}
          {body()}
        </View>
      )}
    </View>
  );

  function body(): ReactNode {
    if (onlyWhitespace) return <Text style={styles.note}>Only whitespace changed.</Text>;
    if (file.binary) return <BinaryBody theme={theme} file={file} source={source} noteStyle={styles.note} />;
    if (!monaco || text.status === "failed") return nativeBody;
    if (matched == null) return <View style={{ height: estimateHeight(block) }} />;
    return (
      <MonacoFileDiff
        block={matched.block}
        source={source}
        text={matched.text}
        view={view}
        theme={theme}
        palette={palette}
        overflowHost={overflowHost}
        comments={fileComments}
        fallback={nativeBody}
      />
    );
  }
});

function NativeBody({
  block,
  source,
  view,
  styles,
  theme,
  palette,
  comments,
}: {
  block: FileBlock;
  source: CodeSource;
  view: ViewOptions;
  styles: DiffStyles;
  theme: PluginTheme;
  palette: SyntaxPalette | null;
  comments: FileComments;
}) {
  const hunks = useMemo(() => blockHunks(block, view.hideWhitespace), [block, view.hideWhitespace]);
  const syntax = useSyntax(source, block.file, block.file.hunks.length > 0 && !block.file.binary);
  const cards = fileCards(comments);
  const unplaced = cards.filter((card) => hunks.every((hunk) => cardLine(card, hunk.lines) < 0));
  const slot = (card: Card) => (
    <CommentSlot key={cardKey(card)} theme={theme} file={block.file} card={card} comments={comments} />
  );
  const rows = { gutter: gutterWidth(block.file), view, styles, syntax, palette, cards, comments, slot };
  const body = hunks.map((hunk, i) => <HunkView key={i} hunk={hunk} {...rows} />);
  return (
    <>
      {scrollsSideways(view) ? (
        <ScrollView horizontal contentContainerStyle={styles.sideways}>
          <View style={styles.sidewaysColumn}>{body}</View>
        </ScrollView>
      ) : (
        body
      )}
      <UnplacedCards theme={theme} block={block} cards={unplaced} comments={comments} />
    </>
  );
}

function scrollsSideways(view: ViewOptions): boolean {
  return view.layout === "unified" && !view.wrapLines;
}

interface RowProps {
  readonly gutter: number;
  readonly view: ViewOptions;
  readonly styles: DiffStyles;
  readonly syntax: FileSyntax | null;
  readonly palette: SyntaxPalette | null;
  readonly cards: readonly Card[];
  readonly comments: FileComments;
  readonly slot: (card: Card) => ReactNode;
}

function HunkView({ hunk, gutter, view, styles, syntax, palette, cards, comments, slot }: RowProps & { hunk: ShownHunk }) {
  const { lines } = hunk;
  const positions = new Map(lines.map((line, i) => [line, i]));
  const indexOf = (line: DiffLine) => positions.get(line) ?? -1;
  const cardsByLine = new Map<number, ReactNode[]>();
  for (const card of cards) {
    const index = cardLine(card, lines);
    if (index >= 0) cardsByLine.set(index, [...(cardsByLine.get(index) ?? []), slot(card)]);
  }
  const cardsAt = (index: number) => cardsByLine.get(index) ?? [];
  const gutterFor = (line: DiffLine) => {
    const index = indexOf(line);
    return {
      onPress: () => comments.compose(lines, index, index),
      onLongPress: () => comments.compose(lines, index, index, true),
    };
  };
  const cell = { styles, syntax, palette };
  const body =
    view.layout === "split"
      ? splitRows(lines).map((row, i) => {
          const indexes = new Set([row.left, row.right].flatMap((line) => (line == null ? [] : [indexOf(line)])));
          return (
            <View key={i}>
              <SplitLineRow row={row} gutter={gutter} gutterFor={gutterFor} {...cell} />
              {[...indexes].flatMap(cardsAt)}
            </View>
          );
        })
      : lines.map((line, i) => (
          <View key={i}>
            <LineRow line={line} gutter={gutter} wrap={!scrollsSideways(view)} press={gutterFor(line)} {...cell} />
            {cardsAt(i)}
          </View>
        ));
  return (
    <View>
      <MutedRow text={hunk.header} gutter={gutter} styles={styles} />
      {body}
    </View>
  );
}

interface GutterPress {
  onPress(): void;
  onLongPress(): void;
}

interface CellProps {
  readonly styles: DiffStyles;
  readonly syntax: FileSyntax | null;
  readonly palette: SyntaxPalette | null;
}

function LineRow({
  line,
  gutter,
  wrap,
  press,
  styles,
  syntax,
  palette,
}: CellProps & { line: DiffLine; gutter: number; wrap: boolean; press: GutterPress }) {
  const look = lineLook(line, styles);
  return (
    <>
      <View style={look.row} dataSet={CODE_SURFACE}>
        <LineNumber
          number={line.kind === "del" ? line.oldNumber : line.newNumber}
          gutter={gutter}
          style={look.number}
          press={press}
        />
        <Text style={wrap ? styles.code : styles.codeSideways} selectable>
          {codeContent(line, syntax, palette)}
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
  ...cell
}: CellProps & { row: SplitRow; gutter: number; gutterFor(line: DiffLine): GutterPress }) {
  return (
    <View style={cell.styles.row} dataSet={CODE_SURFACE}>
      <SplitCell line={row.left} number={row.left?.oldNumber ?? null} gutter={gutter} gutterFor={gutterFor} {...cell} />
      <View style={cell.styles.splitDivider} />
      <SplitCell line={row.right} number={row.right?.newNumber ?? null} gutter={gutter} gutterFor={gutterFor} {...cell} />
    </View>
  );
}

function SplitCell({
  line,
  number,
  gutter,
  gutterFor,
  styles,
  syntax,
  palette,
}: CellProps & { line: DiffLine | null; number: number | null; gutter: number; gutterFor(line: DiffLine): GutterPress }) {
  if (line == null) {
    return <View style={styles.splitCell} />;
  }
  const look = lineLook(line, styles);
  return (
    <View style={[styles.splitCell, look.row]}>
      <LineNumber number={number} gutter={gutter} style={look.number} press={gutterFor(line)} />
      <Text style={styles.code} selectable>
        {codeContent(line, syntax, palette)}
      </Text>
    </View>
  );
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

function codeContent(line: DiffLine, syntax: FileSyntax | null, palette: SyntaxPalette | null): ReactNode {
  const tokens = lineTokens(syntax, palette, line);
  if (tokens == null) return expandTabs(line.text);
  return tokens.map((token, i) => (
    <Text key={i} style={token.color == null ? undefined : { color: token.color }}>
      {expandTabs(token.text)}
    </Text>
  ));
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

function fileNotes(file: DiffFile): string[] {
  const oldMode = file.header.find((line) => line.startsWith("old mode "))?.slice(9);
  const newMode = file.header.find((line) => line.startsWith("new mode "))?.slice(9);
  const notes: string[] = [];
  if (oldMode != null && newMode != null) notes.push(`Mode changed from ${oldMode} to ${newMode}.`);
  if (file.hunks.length === 0 && !file.binary) {
    if (file.status === "renamed") notes.push("Renamed without content changes.");
    if (file.status === "copied") notes.push("Copied without content changes.");
    if (file.status === "added") notes.push("Empty file added.");
    if (file.status === "deleted") notes.push("Empty file deleted.");
  }
  return notes;
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

function createStyles(theme: PluginTheme) {
  const { colors } = theme;
  const code = { fontFamily: MONOSPACE, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT } as const;
  const row = { flexDirection: "row" } as const;
  const number = {
    ...code,
    color: colors.foregroundMuted,
    textAlign: "right",
    paddingRight: 7,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  } as const;
  return StyleSheet.create({
    list: { flex: 1, backgroundColor: colors.surface0 },
    overflowHost: { position: "absolute", top: 0, left: 0, width: 0, height: 0, zIndex: 20 },
    fileHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 30,
      paddingLeft: 12,
      paddingRight: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.surface0,
    },
    fileHeaderPressed: { backgroundColor: colors.surface1 },
    commentCount: { flexDirection: "row", alignItems: "center", gap: 4 },
    viewedToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      height: 22,
      paddingHorizontal: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
    },
    viewedLabel: { fontSize: 12, color: colors.foregroundMuted },
    body: { borderBottomWidth: 1, borderBottomColor: colors.border },
    sideways: { minWidth: "100%" },
    sidewaysColumn: { flexGrow: 1 },
    row,
    addRow: { ...row, backgroundColor: tint(colors.statusSuccess, 0.15) },
    delRow: { ...row, backgroundColor: tint(colors.statusDanger, 0.1) },
    splitCell: { ...row, flex: 1, flexBasis: 0 },
    splitDivider: { width: 1, backgroundColor: colors.border },
    number,
    addNumber: { ...number, color: colors.statusSuccess },
    delNumber: { ...number, color: colors.statusDanger },
    code: { ...code, flex: 1, flexShrink: 1, paddingHorizontal: 8, color: colors.foreground },
    codeSideways: { ...code, paddingHorizontal: 8, color: colors.foreground },
    mutedCode: { ...code, flex: 1, paddingHorizontal: 8, color: colors.foregroundMuted },
    note: { fontSize: 12, lineHeight: 18, paddingHorizontal: 12, paddingVertical: 6, color: colors.foregroundMuted },
  });
}
