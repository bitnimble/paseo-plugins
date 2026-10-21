import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import type { FileBlock } from "../shared/guide";
import type { ViewOptions } from "../shared/settings";
import { type BlockSides, CONTEXT_LINES, type Side, blockSides } from "../shared/sides";
import { type Card, CommentSlot, type FileComments, UnplacedCards, cardKey, cardLine, fileCards } from "./comments";
import type { CodeEditor, DecorationsCollection, DiffEditor, IDisposable, Monaco, MonacoModel, MonacoRange } from "./monaco/api";
import { CommentZones, type ZoneSpec } from "./monaco/comment-zones";
import { type CodeSource, reviewMonaco } from "./monaco/review-monaco";
import { THEME_NAME, type SyntaxPalette } from "./monaco/theme";
import { CODE_SURFACE, MONOSPACE } from "./palette";
import { asEditorContainer, asOverflowHost } from "./web";

const LINE_HEIGHT = 18;
const SCROLLBAR_SIZE = 10;
const SPLIT_MIN_WIDTH = 560;
const CARD_HEIGHT_ESTIMATE = 96;
// Above the diff editor's own zones on the same line, such as inline removed lines.
const ZONE_ORDINAL = 10_000;
const GLYPH_CLASS = "codicon codicon-add review-comment-glyph";

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
  readonly fallback: ReactNode;
}

export function MonacoFileDiff(props: MonacoFileDiffProps) {
  const { block, text, view, theme, palette, overflowHost, comments, fallback } = props;
  const { file } = block;
  const sides = useStableSides(useMemo(() => blockSides(block, text, view.hideWhitespace), [block, text, view.hideWhitespace]));
  const single: SideName | null = sides.original.text === "" ? "modified" : sides.modified.text === "" ? "original" : null;
  const [container, setContainer] = useState<object | null>(null);
  const [editors, setEditors] = useState<Editors | null>(null);
  const [height, setHeight] = useState(() => estimateHeight(block));
  const [failed, setFailed] = useState(false);
  const [cardHeights, setCardHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const [cardTops, setCardTops] = useState<ReadonlyMap<string, number>>(new Map());
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
            const diff = monaco.editor.createDiffEditor(node, options);
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
          const measure = () => setHeight(Math.max(...inner.map((editor) => editor.getContentHeight())) + SCROLLBAR_SIZE);
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
      if (created.diff != null) created.diff.dispose();
      else for (const editor of innerEditors(created)) editor.dispose();
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
    try {
      if (editors.modified != null) {
        modified = reviewMonaco.acquireModified(monaco, source, block.file.path, sides.modified.text, treeLines(sides.modified));
      }
      if (editors.original != null) {
        original = reviewMonaco.originalModel(monaco, block.file.oldPath ?? block.file.path, sides.original.text);
      }
      if (diff != null && original != null && modified != null) {
        diff.setModel({ original, modified });
      } else {
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
    if (editors == null || disposed.current.has(editors)) return;
    const glyphMargin = editors.monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
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
          if (target.type !== glyphMargin || line == null || line > lines.length) return;
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

  if (failed) return <>{fallback}</>;
  return (
    <View>
      <View ref={(node) => setContainer(node)} style={{ height }} dataSet={CODE_SURFACE} />
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
      <UnplacedCards theme={theme} block={block} cards={unplaced} comments={comments} />
    </View>
  );
}

export function estimateHeight(block: FileBlock): number {
  const lines = block.chunks.reduce((sum, chunk) => sum + chunk.end - chunk.start, 0);
  return Math.min(lines, 40) * LINE_HEIGHT + SCROLLBAR_SIZE;
}

/** The previous sides while the content is the same, so a diff refresh leaves the editor alone. */
function useStableSides(next: BlockSides): BlockSides {
  const kept = useRef(next);
  if (!sameSides(kept.current, next)) kept.current = next;
  return kept.current;
}

function sameSides(a: BlockSides, b: BlockSides): boolean {
  const sameSide = (x: Side, y: Side) =>
    x.text === y.text &&
    x.lines.every((line, i) => line.oldNumber === y.lines[i].oldNumber && line.newNumber === y.lines[i].newNumber);
  return sameSide(a.original, b.original) && sameSide(a.modified, b.modified);
}

/** Null when the side is the tree's file itself. */
function treeLines(side: Side): (number | null)[] | null {
  const numbers = side.lines.map((line) => line.newNumber);
  return numbers.every((number, i) => number === i + 1) ? null : numbers;
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
    // The page scrolls; each editor is as tall as its content.
    scrollbar: {
      vertical: "hidden",
      alwaysConsumeMouseWheel: false,
      horizontalScrollbarSize: SCROLLBAR_SIZE,
      useShadows: false,
    },
    experimental: { showMoves: true },
  };
}
