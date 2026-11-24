import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import type { CommentDraft } from "../kit/client/comments";
import { CentreAboveKeyboard, useCentreAboveKeyboard } from "../kit/client/keyboard";
import { CODE_SURFACE } from "../kit/client/palette";
import { useSyntaxPalette } from "../kit/client/syntax-colors";
import { type CommentStore, useCommentDrafts } from "../kit/client/use-comment-drafts";
import { ScrollLock } from "../kit/client/zoomable-image";
import { type FileBlock, blockChanges, blockLines } from "../kit/shared/blocks";
import type { DraftComment } from "../kit/shared/protocol";
import { CAPPED_CHANGES, MORE_CHANGES_STEP } from "../kit/shared/sides";
import type { ViewOptions } from "../shared/settings";
import { CODE_LINE_HEIGHT, FILE_HEADER_HEIGHT, createStyles } from "./diff-styles";
import { FileBlockView } from "./file-block";
import type { CodeSource } from "./monaco/review-monaco";
import { SettledWidth } from "./settled-width";
import { type VisualView, defaultVisualView } from "./visual-view";
import { installStickyStyle, isMonacoSupported } from "./web";
import { ScrollList, type ScrollListHandle, type WindowedRow } from "./windowed-rows";

const COLLAPSE_OVER_CHANGES = 800;
const NO_COMMENTS: readonly DraftComment[] = [];

const RESTORE_LANDED_PX = 4;
const RESTORE_MAX_TICKS = 24;
const RESTORE_TICK_MS = 80;
const RESTORE_FIRST_TICK_MS = 60;

export interface RestorePoint {
  readonly block: number;
  readonly within: number;
}

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
  /** Shown below the block at `index`, e.g. where a section ends. */
  readonly trailing?: (index: number) => ReactNode;
  /** `within` is how far past the top of the block, or the heading above it, the view's top is. */
  readonly onTopBlock?: (index: number, within: number) => void;
  /** Where to scroll once restore runs; kept in view as rows render in. */
  readonly restore?: RestorePoint;
  /** Holds restore off until the saved place has loaded, so mount position is not persisted over it. */
  readonly restoreReady?: boolean;
  readonly onRestored?: () => void;
}

interface Folding {
  /** Every file's state, or null for the default: viewed, generated and very long files collapsed. */
  readonly base: boolean | null;
  /** Collapsed state set on one file since, by its header or its Viewed checkbox. */
  readonly overrides: ReadonlyMap<string, boolean>;
}

export function DiffList(props: DiffListProps) {
  const { blocks, source, theme, view, target, fold, viewed, header, footer, restoreReady } = props;
  const list = useRef<ScrollListHandle>(null);
  const [folding, setFolding] = useState<Folding>(() => ({ base: fold?.collapsed ?? null, overrides: new Map() }));
  const [changeLimits, setChangeLimits] = useState<ReadonlyMap<string, number>>(new Map());
  const styles = useMemo(() => createStyles(theme), [theme]);
  const palette = useSyntaxPalette(theme);
  const [overflowHost, setOverflowHost] = useState<object | null>(null);
  const { draft, actions } = useCommentDrafts(props.comments);
  const frame = useRef<View>(null);
  const { centre: centreAboveKeyboard, bottomInset } = useCentreAboveKeyboard(frame, list, draft != null);
  const latest = useRef({ props });
  latest.current = { props };
  useEffect(installStickyStyle, []);

  const setCollapsed = useCallback((key: string, collapsed: boolean) => {
    setFolding(({ base, overrides }) => ({ base, overrides: new Map(overrides).set(key, collapsed) }));
  }, []);

  const showMore = useCallback(
    (key: string, shown: number) => setChangeLimits((limits) => new Map(limits).set(key, shown + MORE_CHANGES_STEP)),
    [],
  );
  const [visualViews, setVisualViews] = useState<ReadonlyMap<string, VisualView>>(new Map());
  const [scrollLocked, setScrollLocked] = useState(false);
  const setVisualView = useCallback(
    (key: string, visualView: VisualView) => setVisualViews((views) => new Map(views).set(key, visualView)),
    [],
  );

  const markViewed = useCallback((block: FileBlock, isViewed: boolean) => {
    latest.current.props.viewed?.setViewed(block, isViewed);
  }, []);

  const lastViewed = useRef(new Map<FileBlock, boolean>());
  useEffect(() => {
    if (viewed == null) return;
    const seen = new Map<FileBlock, boolean>();
    const flipped: [string, boolean][] = [];
    blocks.forEach((block, index) => {
      const isViewed = viewed.isViewed(block);
      const before = lastViewed.current.get(block);
      seen.set(block, isViewed);
      if (before != null && before !== isViewed) flipped.push([foldKeyOf(block, index), isViewed]);
    });
    lastViewed.current = seen;
    if (flipped.length > 0) {
      setFolding(({ base, overrides }) => ({ base, overrides: new Map([...overrides, ...flipped]) }));
    }
  });

  const commentsByFile = useMemo(() => {
    const byFile = new Map<string, DraftComment[]>();
    for (const comment of props.comments.comments) {
      const existing = byFile.get(comment.filePath);
      if (existing == null) byFile.set(comment.filePath, [comment]);
      else existing.push(comment);
    }
    return byFile;
  }, [props.comments.comments]);
  useEffect(() => {
    if (fold != null) setFolding({ base: fold.collapsed, overrides: new Map() });
  }, [fold]);

  const scrollToBlockTop = useCallback(
    (index: number): number | null => {
      const top = blockTopOf(list.current, blocks, index);
      if (top != null) list.current?.scrollTo(Math.min(top, list.current.maxOffset()), false);
      return top;
    },
    [blocks],
  );

  const reportTopBlock = useCallback((index: number): void => {
    const top = blockTopOf(list.current, latest.current.props.blocks, index);
    latest.current.props.onTopBlock?.(index, Math.max(0, (list.current?.offset() ?? 0) - (top ?? 0)));
  }, []);

  const scrolledTo = useRef<number | null>(null);
  const restoreSuperseded = useRef(false);
  useEffect(() => {
    const block = target == null ? undefined : blocks[target.blockIndex];
    if (target == null || block == null || scrolledTo.current === target.nonce) return;
    scrolledTo.current = target.nonce;
    restoreSuperseded.current = true;
    scrollToBlockTop(target.blockIndex);
  }, [target, blocks, scrollToBlockTop]);

  const didRestore = useRef(false);
  useEffect(() => {
    if (restoreReady === false || didRestore.current) return;
    didRestore.current = true;
    const { restore } = latest.current.props;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      latest.current.props.onRestored?.();
    };
    if (restore == null) {
      finish();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ticks = 0;
    let prevTop = Number.NEGATIVE_INFINITY;
    let requestedSeq = -1;
    const tick = (): void => {
      if (done) return;
      if (restoreSuperseded.current) {
        finish();
        return;
      }
      const blockTop = blockTopOf(list.current, latest.current.props.blocks, restore.block);
      const top = blockTop == null ? null : Math.min(blockTop + restore.within, list.current?.maxOffset() ?? Infinity);
      if (top == null || ++ticks > RESTORE_MAX_TICKS) {
        finish();
        return;
      }
      // Our last jump has not produced a scroll event yet: wait for the real position before judging progress.
      if (requestedSeq >= 0 && (list.current?.scrollSeq() ?? 0) === requestedSeq) {
        timer = setTimeout(tick, RESTORE_TICK_MS);
        return;
      }
      // The real scrolled position, not the target jumpTo optimistically records before the list is tall enough.
      const reached = list.current?.settledOffset() ?? 0;
      // Landed only once the target stops moving: collapsing viewed files shrink it over the first frames.
      const stable = Math.abs(top - prevTop) <= RESTORE_LANDED_PX;
      prevTop = top;
      if (stable && Math.abs(reached - top) <= RESTORE_LANDED_PX) {
        finish();
        return;
      }
      list.current?.scrollTo(top, false);
      requestedSeq = list.current?.scrollSeq() ?? 0;
      timer = setTimeout(tick, RESTORE_TICK_MS);
    };
    timer = setTimeout(tick, RESTORE_FIRST_TICK_MS);
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [restoreReady]);

  const rows: WindowedRow[] = [
    ...(header == null ? [] : [fixedRow("header", header)]),
    ...blocks.flatMap((item, index): WindowedRow[] => {
      const isViewed = viewed?.isViewed(item) ?? null;
      const foldKey = foldKeyOf(item, index);
      const collapsed = folding.overrides.get(foldKey) ?? folding.base ?? (isViewed === true || collapsedByDefault(item));
      const fileComments = commentsByFile.get(item.file.path) ?? NO_COMMENTS;
      const fileDraft =
        draft != null && draftPath(draft) === item.file.path && (draft.kind === "edit" || draft.blockKey === foldKey)
          ? draft
          : null;
      const blockRow: WindowedRow = {
        key: blockKey(item, index),
        blockIndex: index,
        pinned: fileDraft != null,
        estimate: FILE_HEADER_HEIGHT + (collapsed ? 0 : blockLines(item) * CODE_LINE_HEIGHT),
        render: () => (
          <FileBlockView
            block={item}
            foldKey={foldKey}
            source={source}
            overflowHost={overflowHost}
            collapsed={collapsed}
            changeLimit={changeLimits.get(foldKey) ?? CAPPED_CHANGES}
            onShowMore={showMore}
            visual={visualViews.get(foldKey) ?? defaultVisualView(item.file)}
            onVisual={setVisualView}
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
        ),
      };
      const heading = props.heading?.(index);
      const trailing = props.trailing?.(index);
      return [
        ...(heading == null ? [] : [fixedRow(headingKey(index), heading, index)]),
        blockRow,
        ...(trailing == null ? [] : [fixedRow(trailingKey(index), trailing)]),
      ];
    }),
    ...(footer == null ? [] : [fixedRow("footer", footer)]),
  ];

  const body = (
    <View ref={frame} style={styles.list}>
      <ScrollLock.Provider value={setScrollLocked}>
        <CentreAboveKeyboard.Provider value={centreAboveKeyboard}>
          <ScrollList
            handle={list}
            rows={rows}
            style={styles.list}
            scrollEnabled={!scrollLocked}
            bottomInset={bottomInset}
            onTopBlock={props.onTopBlock == null ? undefined : reportTopBlock}
          />
        </CentreAboveKeyboard.Provider>
      </ScrollLock.Provider>
      {isMonacoSupported() ? (
        <View ref={(node) => setOverflowHost(node)} style={styles.overflowHost} dataSet={CODE_SURFACE} />
      ) : null}
    </View>
  );
  return <SettledWidth>{body}</SettledWidth>;
}

function fixedRow(key: string, content: ReactNode, blockIndex?: number): WindowedRow {
  return { key, blockIndex, pinned: false, estimate: 0, render: () => content };
}

function foldKeyOf(block: FileBlock, index: number): string {
  // By place as well as path: the same file can be a block in several sections.
  return `${index}:${block.file.path}`;
}

function blockKey(block: FileBlock, index: number): string {
  return `${block.file.index}:${index}`;
}

function blockTopOf(list: ScrollListHandle | null, blocks: readonly FileBlock[], index: number): number | null {
  const block = blocks[index];
  if (block == null) return null;
  return list?.topOf(headingKey(index)) ?? list?.topOf(blockKey(block, index)) ?? null;
}

function headingKey(index: number): string {
  return `heading:${index}`;
}

function trailingKey(index: number): string {
  return `trailing:${index}`;
}

function draftPath(draft: CommentDraft): string {
  return draft.kind === "edit" ? draft.comment.filePath : draft.filePath;
}

function collapsedByDefault(block: FileBlock): boolean {
  return block.file.generated || blockChanges(block) > COLLAPSE_OVER_CHANGES;
}
