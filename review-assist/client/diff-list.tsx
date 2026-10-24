import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, type FlatList as NativeFlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { CommentTarget } from "../shared/comments";
import { type DiffFile, type DiffLine, isChange } from "../shared/diff";
import { type Span, type SplitRow, splitRows, wordChanges } from "../shared/display";
import { type FileBlock, blockChanges, blockCounts } from "../shared/guide";
import type { DraftComment } from "../shared/protocol";
import type { ViewOptions } from "../shared/settings";
import {
  CAPPED_CHANGES,
  CONTEXT_LINES,
  type ShownHunk,
  type SideLine,
  blockHunks,
  hunksOf,
  rangeHeader,
  takeChanges,
  wholeFileLines,
} from "../shared/sides";
import {
  type Card,
  type CommentDraft,
  CommentSlot,
  type FileComments,
  UnplacedCards,
  cardKey,
  cardLine,
  type ScopeEdge,
  type Suggestion,
  draftScope,
  fileCards,
  inScope,
  scopeEdges,
} from "./comments";
import { BinaryBody, LfsBody } from "./binary-view";
import { ChangeStats, FileLabel, ShowFullDiff, Tabs } from "./controls";
import { DEFAULT_DIAGRAM_VIEW, type DiagramView, MermaidBody, isMermaid } from "./mermaid-view";
import { CentreAboveKeyboard, afterKeyboard, centring, spanOf } from "./keyboard";
import { ScrollLock } from "./zoomable-image";
import { MonacoFileDiff, estimateHeight } from "./monaco-diff";
import type { CodeSource } from "./monaco/review-monaco";
import type { SyntaxPalette } from "./monaco/theme";
import { CODE_SURFACE, IN_SCOPE_ALPHA, MONOSPACE, diffAlpha, tint } from "./palette";
import { type ColoredText, type FileSyntax, lineTokens } from "./syntax";
import { useFileText, usePalette, useSyntax } from "./use-code";
import { isMonacoSupported } from "./web";

const COLLAPSE_OVER_CHANGES = 800;
const MAX_SCROLL_ATTEMPTS = 60;
const CODE_FONT_SIZE = 12;
const CODE_LINE_HEIGHT = 18;
const NO_COMMENTS: readonly DraftComment[] = [];
const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);
const EXPAND_STEP = 20;
const MAX_REVEAL_ALL = 400;
const NO_RANGES: readonly Range[] = [];
const DIAGRAM_VIEWS = [
  { value: "visual", label: "Visual" },
  { value: "text", label: "Text" },
] as const;

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
  compose(filePath: string, blockKey: string, lines: readonly SideLine[], start: number, end: number, extend: boolean): void;
  edit(comment: DraftComment): void;
  cancel(): void;
  submit(target: CommentTarget, body: string, suggestion: Suggestion | null): void;
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
  /** Shown above the block at `index`, e.g. where a section starts. */
  readonly heading?: (index: number) => ReactNode;
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
  const [shownInFull, setShownInFull] = useState<ReadonlySet<string>>(new Set());
  const styles = useMemo(() => createStyles(theme), [theme]);
  const palette = usePalette(theme);
  const [overflowHost, setOverflowHost] = useState<object | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const bottomInset = draft == null ? 0 : keyboardInset;
  const latest = useRef({ props, draft, bottomInset });
  latest.current = { props, draft, bottomInset };
  const frame = useRef<View>(null);
  const scrollY = useRef(0);
  const pendingScroll = useRef<number | null>(null);
  const scrollToPending = useCallback(() => {
    if (pendingScroll.current == null) return;
    list.current?.scrollToOffset({ offset: pendingScroll.current, animated: true });
    pendingScroll.current = null;
  }, []);
  const centreAboveKeyboard = useCallback(
    (node: View) => {
      let live = true;
      const stop = afterKeyboard(async (visible) => {
        if (frame.current == null) return;
        const [shown, target] = await Promise.all([spanOf(frame.current), spanOf(node)]);
        if (!live) return;
        const { scroll, bottomInset: inset } = centring(shown, target, visible);
        pendingScroll.current = Math.max(0, scrollY.current + scroll);
        // The effect on the inset scrolls once the space is laid out.
        if (inset === latest.current.bottomInset) scrollToPending();
        else setKeyboardInset(inset);
      });
      return () => {
        live = false;
        stop();
      };
    },
    [scrollToPending],
  );
  useEffect(scrollToPending, [bottomInset, scrollToPending]);

  const setCollapsed = useCallback((key: string, collapsed: boolean) => {
    setFolding(({ base, overrides }) => ({ base, overrides: new Map(overrides).set(key, collapsed) }));
  }, []);

  const showFull = useCallback((key: string) => setShownInFull((keys) => new Set(keys).add(key)), []);
  const [diagramViews, setDiagramViews] = useState<ReadonlyMap<string, DiagramView>>(new Map());
  const [scrollLocked, setScrollLocked] = useState(false);
  const setDiagramView = useCallback(
    (key: string, diagramView: DiagramView) => setDiagramViews((views) => new Map(views).set(key, diagramView)),
    [],
  );

  const markViewed = useCallback(
    (block: FileBlock, key: string, isViewed: boolean) => {
      setCollapsed(key, isViewed);
      latest.current.props.viewed?.setViewed(block, isViewed);
    },
    [setCollapsed],
  );

  const actions = useMemo(
    (): CommentActions => ({
      compose: (filePath, blockKey, lines, start, end, extend) =>
        setDraft((current): CommentDraft => {
          const same = current?.kind === "new" && current.blockKey === blockKey ? current : null;
          const from = same == null ? -1 : lines.indexOf(same.lines[same.start]);
          const to = same == null ? -1 : lines.indexOf(same.lines[same.end]);
          if (!extend || from < 0 || to < 0) return { kind: "new", filePath, blockKey, lines, start, end };
          return { kind: "new", filePath, blockKey, lines, start: Math.min(from, start), end: Math.max(to, end) };
        }),
      edit: (comment) => setDraft({ kind: "edit", comment }),
      cancel: () => setDraft(null),
      submit: (target, body, suggestion) => {
        const { draft: current, props: currentProps } = latest.current;
        currentProps.comments.save(
          current?.kind === "edit"
            ? { ...current.comment, body, suggestion }
            : { ...target, id: newCommentId(), body, suggestion, createdAt: new Date().toISOString() },
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
    () => [folding, shownInFull, diagramViews, viewed, commentsByFile, draft, palette],
    [folding, shownInFull, diagramViews, viewed, commentsByFile, draft, palette],
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
    <View ref={frame} style={styles.list}>
      <ScrollLock.Provider value={setScrollLocked}>
        <CentreAboveKeyboard.Provider value={centreAboveKeyboard}>
          <FlatList
            ref={list}
            style={styles.list}
            scrollEnabled={!scrollLocked}
            // Else the first tap with the keyboard up only dismisses it, eating a long-press to extend a comment.
            keyboardShouldPersistTaps="handled"
            onScroll={(event) => {
              scrollY.current = event.nativeEvent.contentOffset.y;
            }}
            scrollEventThrottle={16}
            contentContainerStyle={{ paddingBottom: bottomInset }}
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
            renderItem={({ item, index }) => {
              const isViewed = viewed?.isViewed(item) ?? null;
              // By place as well as path: the same file can be a block in several sections.
              const foldKey = `${index}:${item.file.path}`;
              const collapsed =
                folding.overrides.get(foldKey) ?? folding.base ?? (isViewed === true || collapsedByDefault(item));
              const fileComments = commentsByFile.get(item.file.path) ?? NO_COMMENTS;
              const fileDraft =
                draft != null && draftPath(draft) === item.file.path && (draft.kind === "edit" || draft.blockKey === foldKey)
                  ? draft
                  : null;
              const block = (
                <FileBlockView
                  block={item}
                  foldKey={foldKey}
                  source={source}
                  overflowHost={overflowHost}
                  collapsed={collapsed}
                  // A cut could hide comments on the lines past it. Not drafts: they hold the cut sides' lines.
                  capped={fileComments.length === 0 && !shownInFull.has(foldKey)}
                  onShowFull={showFull}
                  diagram={isMermaid(item.file) ? (diagramViews.get(foldKey) ?? DEFAULT_DIAGRAM_VIEW) : null}
                  onDiagram={setDiagramView}
                  viewed={isViewed}
                  comments={fileComments}
                  draft={fileDraft}
                  actions={actions}
                  onCollapse={setCollapsed}
                  onViewed={markViewed}
                  view={view}
                  styles={styles}
                  theme={theme}
                  palette={palette}
                />
              );
              const heading = props.heading?.(index);
              return heading == null ? (
                block
              ) : (
                <>
                  {heading}
                  {block}
                </>
              );
            }}
          />
        </CentreAboveKeyboard.Provider>
      </ScrollLock.Provider>
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
  return block.file.generated || blockChanges(block) > COLLAPSE_OVER_CHANGES;
}

interface FileBlockViewProps {
  readonly block: FileBlock;
  readonly foldKey: string;
  readonly source: CodeSource;
  readonly overflowHost: object | null;
  readonly collapsed: boolean;
  readonly capped: boolean;
  readonly onShowFull: (foldKey: string) => void;
  /** Null for files that aren't diagrams. */
  readonly diagram: DiagramView | null;
  readonly onDiagram: (foldKey: string, diagram: DiagramView) => void;
  /** Null hides the checkbox. */
  readonly viewed: boolean | null;
  readonly comments: readonly DraftComment[];
  readonly draft: CommentDraft | null;
  readonly actions: CommentActions;
  readonly onCollapse: (foldKey: string, collapsed: boolean) => void;
  readonly onViewed: (block: FileBlock, foldKey: string, viewed: boolean) => void;
  readonly view: ViewOptions;
  readonly styles: DiffStyles;
  readonly theme: PluginTheme;
  readonly palette: SyntaxPalette | null;
}

const FileBlockView = memo(function FileBlockView({
  block,
  foldKey,
  source,
  overflowHost,
  collapsed,
  capped,
  onShowFull,
  diagram,
  onDiagram,
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
  const hasText = file.hunks.length > 0 && !file.binary && !file.lfs;
  const monaco = hasText && overflowHost != null && palette != null;
  const text = useFileText(source, file, (hasText || diagram?.visual === true) && !collapsed);
  // New hunks laid over the file's previous text misplace lines: keep the last pair that agrees.
  const lastMatched = useRef<{ block: FileBlock; text: string } | null>(null);
  if (text.status === "ready" && !text.previous) lastMatched.current = { block, text: text.text };
  const matched = text.status !== "ready" ? null : text.previous ? lastMatched.current : { block, text: text.text };
  const fileComments = useMemo(
    (): FileComments => ({
      comments,
      draft,
      compose: (lines, start, end, extend = false) => actions.compose(file.path, foldKey, lines, start, end, extend),
      edit: actions.edit,
      cancel: actions.cancel,
      submit: actions.submit,
      remove: actions.remove,
    }),
    [comments, draft, actions, file.path, foldKey],
  );
  const onlyWhitespace = useMemo(
    () =>
      view.hideWhitespace &&
      block.chunks.some(({ hunk, start, end }) => hunk.lines.slice(start, end).some(isChange)) &&
      blockHunks(block, true).length === 0,
    [block, view.hideWhitespace],
  );
  const showFull = useMemo(() => (capped ? () => onShowFull(foldKey) : null), [capped, onShowFull, foldKey]);
  const nativeBody = (
    <NativeBody
      block={block}
      source={source}
      view={view}
      styles={styles}
      theme={theme}
      palette={palette}
      comments={fileComments}
      onShowFull={showFull}
      text={matched?.block === block ? matched.text : null}
    />
  );

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${file.path}`}
        accessibilityState={{ expanded: !collapsed }}
        style={({ pressed }) => [styles.fileHeader, pressed && styles.fileHeaderPressed]}
        onPress={() => onCollapse(foldKey, !collapsed)}
      >
        <FileLabel theme={theme} path={file.path} detail={moved ? `from ${file.oldPath}` : undefined} />
        {comments.length === 0 ? null : (
          <View style={styles.commentCount} accessibilityLabel={`${comments.length} unsent ${comments.length === 1 ? "comment" : "comments"}`}>
            <Icon name="MessageSquare" size={12} color={theme.colors.foregroundMuted} />
            <Text style={styles.viewedLabel}>{comments.length}</Text>
          </View>
        )}
        {diagram == null ? null : (
          <Tabs
            theme={theme}
            compact
            value={diagram.visual ? "visual" : "text"}
            options={DIAGRAM_VIEWS}
            onChange={(value) => onDiagram(foldKey, { ...diagram, visual: value === "visual" })}
          />
        )}
        <ChangeStats theme={theme} file={file} {...blockCounts(block)} />
        {viewed == null ? null : (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={`Viewed ${file.path}`}
            aria-checked={viewed}
            hitSlop={6}
            onPress={() => onViewed(block, foldKey, !viewed)}
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
    if (diagram?.visual !== true) return textBody();
    return (
      <MermaidBody
        block={block}
        text={text}
        theme={theme}
        distance={diagram.distance}
        onDistance={(distance) => onDiagram(foldKey, { ...diagram, distance })}
        noteStyle={styles.note}
        fallback={textBody()}
      />
    );
  }

  function textBody(): ReactNode {
    if (onlyWhitespace) return <Text style={styles.note}>Only whitespace changed.</Text>;
    if (file.binary) return <BinaryBody theme={theme} file={file} source={source} noteStyle={styles.note} />;
    if (file.lfs) return <LfsBody theme={theme} file={file} source={source} noteStyle={styles.note} />;
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
        onShowFull={showFull}
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
  onShowFull,
  text,
}: {
  block: FileBlock;
  source: CodeSource;
  view: ViewOptions;
  styles: DiffStyles;
  theme: PluginTheme;
  palette: SyntaxPalette | null;
  comments: FileComments;
  onShowFull: (() => void) | null;
  /** The file as the diff leaves it, once known, to show the lines around the changes. */
  text: string | null;
}) {
  const whole = useMemo(
    () => (text == null ? null : wholeFileLines(block, text, view.hideWhitespace).lines),
    [block, text, view.hideWhitespace],
  );
  const [revealed, setRevealed] = useState<Revealed>({ of: null, ranges: [] });
  const ranges = revealed.of === whole ? revealed.ranges : NO_RANGES;
  const hunks = useMemo(
    () => (whole == null ? blockHunks(block, view.hideWhitespace) : hunksOf(whole, CONTEXT_LINES, ranges)),
    [block, view.hideWhitespace, whole, ranges],
  );
  const reveal = (range: Range) => setRevealed({ of: whole, ranges: [...ranges, range] });
  const shown = useMemo(
    () => (onShowFull == null ? { hunks, cut: false } : firstChanges(hunks, CAPPED_CHANGES)),
    [hunks, onShowFull],
  );
  const marks = useMemo(() => shown.hunks.map((hunk) => wordChanges(hunk.lines)), [shown]);
  const syntax = useSyntax(source, block.file, block.file.hunks.length > 0 && !block.file.binary && !block.file.lfs);
  const cards = fileCards(comments);
  const unplaced = cards.filter((card) => hunks.every((hunk) => cardLine(card, hunk.lines) < 0));
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
  const gap = (from: number, to: number) => (
    <GapRow
      key={`gap:${from}`}
      from={from}
      to={to}
      total={whole?.length ?? 0}
      gutter={gutter}
      theme={theme}
      styles={styles}
      onReveal={reveal}
    />
  );
  const last = shown.hunks[shown.hunks.length - 1];
  const body = [
    ...shown.hunks.flatMap((hunk, i) => [
      whole == null || hunk.start == null ? (
        <MutedRow key={`header:${i}`} text={hunk.header} gutter={gutter} styles={styles} />
      ) : (
        gap(shown.hunks[i - 1]?.end ?? 0, hunk.start)
      ),
      ...hunkRows(hunk, marks[i], rows),
    ]),
    whole == null || shown.cut || last?.end == null ? null : gap(last.end, whole.length),
  ];
  return (
    <>
      <View>
        {sideways ? (
          <AnimatedScrollView
            horizontal
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.sideways}
            onLayout={(event) => setVisibleWidth(event.nativeEvent.layout.width)}
            onScroll={onScrollX}
            scrollEventThrottle={16}
          >
            <View style={styles.sidewaysColumn}>{body}</View>
          </AnimatedScrollView>
        ) : (
          body
        )}
        {shown.cut && onShowFull != null ? (
          <ShowFullDiff theme={theme} lines={blockChanges(block)} onPress={onShowFull} />
        ) : null}
      </View>
      <UnplacedCards theme={theme} block={block} cards={unplaced} comments={comments} />
    </>
  );
}

type Range = readonly [number, number];

/** Line ranges shown on request, valid only for the `of` lines they index. */
interface Revealed {
  readonly of: readonly DiffLine[] | null;
  readonly ranges: readonly Range[];
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

function firstChanges(hunks: readonly ShownHunk[], limit: number): { hunks: readonly ShownHunk[]; cut: boolean } {
  const shown: ShownHunk[] = [];
  let changes = 0;
  for (const hunk of hunks) {
    const taken = takeChanges(hunk.lines, limit - changes);
    if (!taken.cut) {
      shown.push(hunk);
      changes += taken.changes;
      continue;
    }
    if (taken.lines.some(isChange)) shown.push({ header: rangeHeader(taken.lines), lines: taken.lines });
    return { hunks: shown, cut: true };
  }
  return { hunks: shown, cut: false };
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
): ReactNode[] {
  const { lines } = hunk;
  const scope = draftScope(file, comments.draft, [lines]);
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
  const cell = { styles, syntax, palette, marks };
  const covers = (line: DiffLine | null, side: CommentTarget["side"]) =>
    line != null && scope?.side === side && inScope(scope, line);
  return view.layout === "split" ? splitBody() : unifiedBody();

  function splitBody(): ReactNode[] {
    const rows = splitRows(lines);
    const oldEdges = scopeEdges(rows, (row) => covers(row.left, "old"));
    const newEdges = scopeEdges(rows, (row) => covers(row.right, "new"));
    return rows.map((row, i) => {
      const indexes = new Set([row.left, row.right].flatMap((line) => (line == null ? [] : [indexOf(line)])));
      return (
        <View key={`${lineKey(row.left)}|${lineKey(row.right)}`}>
          <SplitLineRow row={row} gutter={gutter} gutterFor={gutterFor} edges={[oldEdges[i], newEdges[i]]} {...cell} />
          {[...indexes].flatMap(cardsAt)}
        </View>
      );
    });
  }

  function unifiedBody(): ReactNode[] {
    const edges = scopeEdges(lines, (line) => scope != null && inScope(scope, line));
    return lines.map((line, i) => (
      <View key={lineKey(line)}>
        <LineRow line={line} gutter={gutter} wrap={!scrollsSideways(view)} press={gutterFor(line)} edge={edges[i]} {...cell} />
        {cardsAt(i)}
      </View>
    ));
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
  const alpha = diffAlpha(theme);
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
    addRow: { ...row, backgroundColor: tint(colors.statusSuccess, alpha.addLine) },
    delRow: { ...row, backgroundColor: tint(colors.statusDanger, alpha.delLine) },
    inScope: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: tint(colors.foreground, IN_SCOPE_ALPHA.fill),
      borderColor: tint(colors.foreground, IN_SCOPE_ALPHA.edge),
      borderLeftWidth: 1,
      borderRightWidth: 1,
    },
    gap: { alignItems: "center", backgroundColor: colors.surface1 },
    gapButtons: { flexDirection: "row", justifyContent: "center", gap: 4, borderRightWidth: 1, borderRightColor: colors.border },
    gapLabel: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 8 },
    inScopeFirst: { borderTopWidth: 1 },
    inScopeLast: { borderBottomWidth: 1 },
    splitCell: { ...row, flex: 1, flexBasis: 0 },
    splitDivider: { width: 1, backgroundColor: colors.border },
    number,
    addMark: { backgroundColor: tint(colors.statusSuccess, alpha.addMark) },
    delMark: { backgroundColor: tint(colors.statusDanger, alpha.delMark) },
    addNumber: { ...number, color: colors.statusSuccess },
    delNumber: { ...number, color: colors.statusDanger },
    code: { ...code, flex: 1, flexShrink: 1, paddingHorizontal: 8, color: colors.foreground },
    codeSideways: { ...code, paddingHorizontal: 8, color: colors.foreground },
    mutedCode: { ...code, flex: 1, paddingHorizontal: 8, color: colors.foregroundMuted },
    note: { fontSize: 12, lineHeight: 18, paddingHorizontal: 12, paddingVertical: 6, color: colors.foregroundMuted },
  });
}
