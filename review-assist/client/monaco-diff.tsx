import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, View } from "react-native";
import { detailsOf } from "../shared/errors";
import { type FileBlock, blockLines } from "../shared/guide";
import type { ViewOptions } from "../shared/settings";
import { type BlockSides, CONTEXT_LINES, type Side, blockSides } from "../shared/sides";
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
  scopeEdges,
} from "./comments";
import { ShowMoreChanges } from "./controls";
import type { CodeEditor, Decoration, DecorationsCollection, DiffEditor, IDisposable, Monaco, MonacoModel, MonacoRange } from "./monaco/api";
import { CommentZones, type ZoneSpec } from "./monaco/comment-zones";
import { type CodeSource, reviewMonaco } from "./monaco/review-monaco";
import { THEME_NAME, type SyntaxPalette } from "./monaco/theme";
import { CODE_SURFACE, MONOSPACE } from "./palette";
import { asEditorContainer, asOverflowHost, signFirstDeletedRows } from "./web";

const LINE_HEIGHT = 18;
const SCROLLBAR_SIZE = 10;
const SPLIT_MIN_WIDTH = 560;
const CARD_HEIGHT_ESTIMATE = 96;
const CARDS_CLIP = { reviewcards: "" } as const;
// Above the diff editor's own zones on the same line, such as inline removed lines.
const ZONE_ORDINAL = 10_000;
const COMMENT_GLYPH = "review-comment-glyph";
const GLYPH_CLASS = `codicon codicon-add ${COMMENT_GLYPH}`;
const INSERT_SIGN = "review-sign insert-sign codicon codicon-diff-insert";
const DELETE_SIGN = "review-sign delete-sign codicon codicon-diff-remove";

type SideName = "original" | "modified";

interface Editors {
  readonly monaco: Monaco;
  /** Null when one side is empty: the other is shown alone, which Monaco's diff renders badly. */
  readonly diff: DiffEditor | null;
  readonly original: CodeEditor | null;
  readonly modified: CodeEditor | null;
}

interface Placement {
  readonly card: Card;
  readonly side: SideName;
  readonly afterLine: number;
}

interface MonacoFileDiffProps {
  readonly block: FileBlock;
  readonly source: CodeSource;
  readonly text: string;
  readonly view: ViewOptions;
  readonly theme: PluginTheme;
  readonly palette: SyntaxPalette;
  /** Outside the list's transformed scroll content, which offsets the diff editor's `position: fixed` hovers. */
  readonly overflowHost: object;
  readonly comments: FileComments;
  readonly changeLimit: number;
  readonly onShowMore: () => void;
  readonly hidden: number;
  readonly maxHeight: number;
  readonly fallback: ReactNode;
}

export function MonacoFileDiff(props: MonacoFileDiffProps) {
  const { block, text, view, theme, palette, overflowHost, comments, changeLimit, onShowMore, hidden, maxHeight, fallback } =
    props;
  const { file } = block;
  const sides = useStableSides(
    useMemo(
      () => withoutFinalNewline(blockSides(block, text, view.hideWhitespace, changeLimit)),
      [block, text, view.hideWhitespace, changeLimit],
    ),
  );
  const single: SideName | null =
    sides.original.lines.length === 0 ? "modified" : sides.modified.lines.length === 0 ? "original" : null;
  const [container, setContainer] = useState<object | null>(null);
  const [editors, setEditors] = useState<Editors | null>(null);
  const [settled, setSettled] = useState<Editors | null>(null);
  const [nativeFirst, setNativeFirst] = useState(() => !reviewMonaco.loaded);
  const [height, setHeight] = useState(() => estimateHeight(block));
  const [failed, setFailed] = useState(false);
  const [cardHeights, setCardHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const [cardTops, setCardTops] = useState<ReadonlyMap<string, number>>(new Map());
  const scrollY = useRef(new Animated.Value(0)).current;
  const zones = useRef<CommentZones | null>(null);
  const disposed = useRef(new WeakSet<Editors>());
  const latest = useRef({ props, sides });
  latest.current = { props, sides };

  useEffect(() => {
    if (container == null) return;
    let live = true;
    let created: Editors | null = null;
    const listeners: IDisposable[] = [];
    reviewMonaco.load().then(
      (monaco) => {
        if (!live) return;
        try {
          const { view, theme, palette } = latest.current.props;
          reviewMonaco.applyTheme(monaco, theme, palette);
          const node = asEditorContainer(container);
          const options = { ...editorOptions(view), overflowWidgetsDomNode: asOverflowHost(overflowHost) };
          if (single == null) {
            const diff = reviewMonaco.createDiffEditor(monaco, node, options);
            created = { monaco, diff, original: diff.getOriginalEditor(), modified: diff.getModifiedEditor() };
          } else {
            const editor = monaco.editor.create(node, options);
            created = {
              monaco,
              diff: null,
              original: single === "original" ? editor : null,
              modified: single === "modified" ? editor : null,
            };
          }
          const inner = innerEditors(created);
          const measure = () => {
            // Monaco reports -1 until a model is attached.
            const measured = Math.max(...inner.map((editor) => editor.getContentHeight()));
            if (measured > 0) setHeight(measured);
          };
          listeners.push(...inner.map((editor) => editor.onDidContentSizeChange(measure)));
          measure();
          zones.current = new CommentZones((key, top) =>
            setCardTops((tops) => (tops.get(key) === top ? tops : new Map(tops).set(key, top))),
          );
          setEditors(created);
        } catch (error) {
          console.warn(`[review-assist] Monaco could not show ${latest.current.props.block.file.path}`, error);
          setFailed(true);
        }
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
      zones.current?.clear();
      zones.current = null;
      setEditors(null);
      setCardTops(new Map());
      for (const listener of listeners) listener.dispose();
      if (created == null) return;
      disposed.current.add(created);
      try {
        if (created.diff != null) created.diff.dispose();
        else for (const editor of innerEditors(created)) editor.dispose();
      } catch (error) {
        console.error(`[review-assist] Monaco could not dispose the editor for ${file.path}\n\n${detailsOf(error)}`);
      }
    };
  }, [container, overflowHost, single]);

  useEffect(() => {
    // For one commit after `single` changes, `editors` is the pair the creation effect just disposed.
    if (editors == null || disposed.current.has(editors)) return;
    const { monaco, diff } = editors;
    const { source, block } = latest.current.props;
    let original: MonacoModel | null = null;
    let modified: MonacoModel | null = null;
    let decorations: DecorationsCollection | null = null;
    let diffed: IDisposable | null = null;
    try {
      if (editors.modified != null) {
        modified = reviewMonaco.acquireModified(monaco, source, block.file.path, sides.modified.text, treeLines(sides.modified, sides.cut));
      }
      if (editors.original != null) {
        original = reviewMonaco.originalModel(monaco, block.file.oldPath ?? block.file.path, sides.original.text);
      }
      if (diff != null && original != null && modified != null) {
        diffed = diff.onDidUpdateDiff(() => setSettled(editors));
        diff.setModel({ original, modified });
      } else {
        setSettled(editors);
        const shown = single === "original" ? sides.original : sides.modified;
        const editor = editors.original ?? editors.modified;
        editor?.setModel(original ?? modified);
        decorations =
          editor?.createDecorationsCollection([
            {
              range: lineRange(1, Math.max(1, shown.lines.length)),
              options: {
                isWholeLine: true,
                className: single === "original" ? "line-delete" : "line-insert",
                marginClassName: single === "original" ? "gutter-delete" : "gutter-insert",
              },
            },
          ]) ?? null;
      }
    } catch (error) {
      console.warn(`[review-assist] Monaco could not show ${block.file.path}`, error);
      setFailed(true);
    }
    return () => {
      diffed?.dispose();
      // Monaco throws when a model attached to a live editor is disposed, and when a disposed editor is touched.
      if (!disposed.current.has(editors)) {
        decorations?.clear();
        // A new model gets a new view, without the old one's zones.
        zones.current?.clear();
        if (diff != null) diff.setModel(null);
        else (editors.original ?? editors.modified)?.setModel(null);
      }
      original?.dispose();
      if (modified != null) reviewMonaco.releaseModified(modified);
    };
  }, [editors, sides, single]);

  useEffect(() => {
    if (editors == null || disposed.current.has(editors)) return;
    const options = editorOptions(view);
    if (editors.diff != null) editors.diff.updateOptions(options);
    else for (const editor of innerEditors(editors)) editor.updateOptions(options);
    // After the diff editor's own options, which set its sides' line numbers.
    editors.original?.updateOptions({ lineNumbers: realNumbers(sides.original, "old") });
    editors.modified?.updateOptions({ lineNumbers: realNumbers(sides.modified, "new") });
  }, [editors, view, sides]);

  useEffect(() => {
    if (editors != null) reviewMonaco.applyTheme(editors.monaco, theme, palette);
  }, [editors, theme, palette]);

  useEffect(() => {
    if (editors?.diff == null || container == null) return;
    return signFirstDeletedRows(container);
  }, [editors, container]);

  useEffect(() => {
    const editor = editors?.modified ?? editors?.original;
    if (editor == null) return;
    scrollY.setValue(-editor.getScrollTop());
    const listener = editor.onDidScrollChange(({ scrollTop }) => scrollY.setValue(-scrollTop));
    return () => listener.dispose();
  }, [editors, scrollY]);

  useEffect(() => {
    if (editors?.diff == null || disposed.current.has(editors)) return;
    const { diff, original, modified } = editors;
    const added = modified?.createDecorationsCollection();
    const removed = original?.createDecorationsCollection();
    const render = (): void => {
      const changes = diff.getLineChanges() ?? [];
      added?.set(changes.flatMap((change) => signs(change.modifiedStartLineNumber, change.modifiedEndLineNumber, INSERT_SIGN)));
      removed?.set(changes.flatMap((change) => signs(change.originalStartLineNumber, change.originalEndLineNumber, DELETE_SIGN)));
    };
    const listener = diff.onDidUpdateDiff(render);
    render();
    return () => {
      listener.dispose();
      if (disposed.current.has(editors)) return;
      added?.clear();
      removed?.clear();
    };
  }, [editors]);

  useEffect(() => {
    if (editors == null || disposed.current.has(editors)) return;
    const listeners: IDisposable[] = [];
    for (const name of ["original", "modified"] as const) {
      const editor = editors[name];
      if (editor == null) continue;
      const { lines } = sides[name];
      const hovered = editor.createDecorationsCollection();
      let hoveredLine = 0;
      listeners.push(
        editor.onMouseMove(({ target }) => {
          const line = target.position?.lineNumber ?? 0;
          const next = line <= lines.length ? line : 0;
          if (next === hoveredLine) return;
          hoveredLine = next;
          hovered.set(hoveredLine === 0 ? [] : [{ range: lineRange(hoveredLine, hoveredLine), options: { glyphMarginClassName: GLYPH_CLASS } }]);
        }),
        editor.onMouseLeave(() => {
          hoveredLine = 0;
          hovered.clear();
        }),
        editor.onMouseDown(({ target }) => {
          const line = target.position?.lineNumber;
          // Only our glyph: the margin also holds Monaco's own controls, such as an unchanged region's collapse.
          if (target.element?.classList.contains(COMMENT_GLYPH) !== true || line == null || line > lines.length) return;
          const [start, end] = selectedLines(editor.getSelection(), line);
          latest.current.props.comments.compose(lines, start - 1, end - 1);
        }),
        { dispose: () => hovered.clear() },
      );
    }
    return () => {
      for (const listener of listeners) listener.dispose();
    };
  }, [editors, sides]);

  const scope = draftScope(file, comments.draft, [sides.original.lines, sides.modified.lines]);
  const scopeKey = scope == null ? "" : `${scope.side}:${scope.startLine}:${scope.lineNumber}`;
  useEffect(() => {
    if (editors == null || disposed.current.has(editors) || scope == null) return;
    const name = scope.side === "old" ? "original" : "modified";
    const editor = editors[name];
    if (editor == null) return;
    const edges = scopeEdges(sides[name].lines, (line) => inScope(scope, line));
    const highlighted = editor.createDecorationsCollection(
      edges.flatMap((edge, i) => {
        if (edge == null) return [];
        const ends = `${edge.first ? " review-scope-first" : ""}${edge.last ? " review-scope-last" : ""}`;
        const options = { isWholeLine: true, className: `review-scope${ends}`, marginClassName: `review-scope-margin${ends}` };
        return [{ range: lineRange(i + 1, i + 1), options }];
      }),
    );
    return () => {
      if (!disposed.current.has(editors)) highlighted.clear();
    };
  }, [editors, sides, scopeKey]);

  const cards = fileCards(comments);
  const placements = cards.flatMap((card) => {
    const placement = placeCard(card, sides, single);
    return placement == null ? [] : [placement];
  });
  const unplaced = cards.filter((card) => !placements.some((placement) => placement.card === card));
  const zoneSpecs = placements.flatMap(({ card, side, afterLine }, index): { spec: ZoneSpec; id: string }[] => {
    const editor = editors?.[side];
    if (editor == null) return [];
    const key = cardKey(card);
    const ordinal = ZONE_ORDINAL + index;
    const height = cardHeights.get(key) ?? CARD_HEIGHT_ESTIMATE;
    return [{ spec: { key, editor, afterLine, ordinal, height }, id: `${key}:${side}:${afterLine}:${ordinal}:${height}` }];
  });
  const zoneKey = zoneSpecs.map(({ id }) => id).join();
  useEffect(() => {
    zones.current?.sync(zoneSpecs.map(({ spec }) => spec));
  }, [editors, sides, zoneKey]);

  const ready = editors != null && settled === editors;
  const composing = comments.draft != null;
  useEffect(() => {
    // Swapping mid-comment would drop the fallback's composer and the text typed into it.
    if (nativeFirst && ready && !composing) setNativeFirst(false);
  }, [nativeFirst, ready, composing]);

  if (failed) return <>{fallback}</>;
  const visible = ready && !nativeFirst;
  const shownHeight = Math.min(height, maxHeight);
  return (
    <View>
      <View>
        <View
          ref={(node) => setContainer(node)}
          style={{
            height: visible ? shownHeight : nativeFirst ? 0 : Math.min(estimateHeight(block), maxHeight),
            opacity: visible ? 1 : 0,
          }}
          dataSet={CODE_SURFACE}
        />
        {nativeFirst ? fallback : null}
        {visible ? (
          <View
            pointerEvents="box-none"
            style={{ position: "absolute", top: 0, left: 0, right: SCROLLBAR_SIZE, height: shownHeight, overflow: "hidden" }}
            // Clipped, not hidden: a composer's autofocus would scroll a hidden-overflow box, shifting every card.
            dataSet={CARDS_CLIP}
          >
            <Animated.View pointerEvents="box-none" style={{ transform: [{ translateY: scrollY }] }}>
              {placements.map(({ card }) => {
                const key = cardKey(card);
                const top = cardTops.get(key);
                if (top == null) return null;
                return (
                  <View
                    key={key}
                    style={{ position: "absolute", top, left: 0, right: 0 }}
                    onLayout={(event) => {
                      const measured = Math.ceil(event.nativeEvent.layout.height);
                      setCardHeights((heights) => (heights.get(key) === measured ? heights : new Map(heights).set(key, measured)));
                    }}
                  >
                    <CommentSlot theme={theme} file={file} card={card} comments={comments} />
                  </View>
                );
              })}
            </Animated.View>
          </View>
        ) : null}
        {sides.cut && !nativeFirst ? (
          <ShowMoreChanges theme={theme} hidden={hidden} onPress={onShowMore} />
        ) : null}
      </View>
      {nativeFirst ? null : <UnplacedCards theme={theme} block={block} cards={unplaced} comments={comments} />}
    </View>
  );
}

export function estimateHeight(block: FileBlock): number {
  return Math.min(blockLines(block), 40) * LINE_HEIGHT;
}

/** Monaco shows a blank line after a final newline; kept where it is the change. */
function withoutFinalNewline(sides: BlockSides): BlockSides {
  const { original, modified } = sides;
  const ends = (side: Side) => side.text === "" || side.text.endsWith("\n");
  if (!ends(original) || !ends(modified)) return sides;
  const trim = (side: Side): Side => (side.text === "" ? side : { ...side, text: side.text.slice(0, -1) });
  return { ...sides, original: trim(original), modified: trim(modified) };
}

/** The previous sides while the content is the same, so a diff refresh leaves the editor alone. */
function useStableSides(next: BlockSides): BlockSides {
  const kept = useRef(next);
  if (!sameSides(kept.current, next)) kept.current = next;
  return kept.current;
}

function sameSides(a: BlockSides, b: BlockSides): boolean {
  if (a === b) return true;
  const sameSide = (x: Side, y: Side) =>
    x.text === y.text &&
    x.lines.length === y.lines.length &&
    x.lines.every((line, i) => line.oldNumber === y.lines[i].oldNumber && line.newNumber === y.lines[i].newNumber);
  return sameSide(a.original, b.original) && sameSide(a.modified, b.modified);
}

/** Null when the side is the tree's file itself. */
function treeLines(side: Side, cut: boolean): (number | null)[] | null {
  const numbers = side.lines.map((line) => line.newNumber);
  return !cut && numbers.every((number, i) => number === i + 1) ? null : numbers;
}

function realNumbers(side: Side, numbering: "old" | "new"): (line: number) => string {
  const labels = side.lines.map((line) => String((numbering === "old" ? line.oldNumber : line.newNumber) ?? ""));
  return (line) => labels[line - 1] ?? "";
}

function placeCard(card: Card, sides: BlockSides, single: SideName | null): Placement | null {
  const inModified = single === "original" ? -1 : cardLine(card, sides.modified.lines);
  if (inModified >= 0) return { card, side: "modified", afterLine: inModified + 1 };
  const inOriginal = single === "modified" ? -1 : cardLine(card, sides.original.lines);
  return inOriginal < 0 ? null : { card, side: "original", afterLine: inOriginal + 1 };
}

function selectedLines(selection: MonacoRange | null, line: number): [number, number] {
  if (selection == null) return [line, line];
  const { startLineNumber: start, endColumn } = selection;
  // A selection made by dragging over line numbers ends at the start of the line after it.
  const end = endColumn === 1 && selection.endLineNumber > start ? selection.endLineNumber - 1 : selection.endLineNumber;
  return line >= start && line <= end ? [start, end] : [line, line];
}

function lineRange(start: number, end: number): MonacoRange {
  return { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 };
}

/** One per line: a first-line decoration marks only the first line of its range. */
function signs(start: number, end: number, className: string): Decoration[] {
  if (end === 0) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => ({
    range: lineRange(start + i, start + i),
    options: { firstLineDecorationClassName: className },
  }));
}

function innerEditors(editors: Editors): CodeEditor[] {
  return [editors.original, editors.modified].filter((editor) => editor != null);
}

function editorOptions(view: ViewOptions): Readonly<Record<string, unknown>> {
  return {
    theme: THEME_NAME,
    readOnly: true,
    domReadOnly: true,
    originalEditable: false,
    automaticLayout: true,
    renderSideBySide: view.layout === "split",
    renderSideBySideInlineBreakpoint: SPLIT_MIN_WIDTH,
    ignoreTrimWhitespace: view.hideWhitespace,
    wordWrap: view.wrapLines || view.layout === "split" ? "on" : "off",
    hideUnchangedRegions: {
      enabled: true,
      contextLineCount: CONTEXT_LINES,
      minimumLineCount: CONTEXT_LINES,
      revealLineCount: 20,
    },
    definitionLinkOpensInPeek: true,
    renderMarginRevertIcon: false,
    renderGutterMenu: false,
    renderOverviewRuler: false,
    overviewRulerLanes: 0,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontFamily: MONOSPACE,
    fontSize: 12,
    lineHeight: LINE_HEIGHT,
    lineNumbersMinChars: 3,
    folding: false,
    glyphMargin: true,
    stickyScroll: { enabled: false },
    renderLineHighlight: "none",
    scrollbar: {
      alwaysConsumeMouseWheel: false,
      verticalScrollbarSize: SCROLLBAR_SIZE,
      horizontalScrollbarSize: SCROLLBAR_SIZE,
      ignoreHorizontalScrollbarInContentHeight: true,
      useShadows: false,
    },
    experimental: { showMoves: true },
  };
}
