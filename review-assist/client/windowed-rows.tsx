import { ScrollView } from "@getpaseo/plugin/client/ui";
import {
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type ScrollView as NativeScrollView, type StyleProp, View, type ViewStyle, useWindowDimensions } from "react-native";

export interface WindowedRow {
  readonly key: string;
  /** What `ScrollList`'s `onTopBlock` reports while this row is at the top of the view. */
  readonly blockIndex?: number;
  /** Kept mounted while scrolled away, for state such as a comment being typed. */
  readonly pinned: boolean;
  /** Its height until it is first laid out. */
  readonly estimate: number;
  render(): ReactNode;
}

export interface Viewport {
  readonly height: number;
  offset(): number;
  subscribe(listener: () => void): () => void;
  scrollTo(offset: number): void;
}

export interface ScrollListHandle {
  offset(): number;
  /** The last position a scroll event reported, never the optimistic target `offset()` may hold mid-jump. */
  settledOffset(): number;
  /** Bumped on every scroll event, so a caller can tell a requested jump has actually landed. */
  scrollSeq(): number;
  topOf(key: string): number | null;
  scrollTo(offset: number, animated: boolean): void;
}

const ViewportContext = createContext<Viewport>({
  height: 0,
  offset: () => 0,
  subscribe: () => () => undefined,
  scrollTo: () => undefined,
});

/** Where content rendered here starts within the list's scrolled content. */
export const ContentTop = createContext(0);

export function useViewport(): Viewport {
  return useContext(ViewportContext);
}

/** The review's only scroll view; `WindowedRows` inside its rows window against it. */
export function ScrollList({
  rows,
  handle,
  style,
  scrollEnabled,
  bottomInset,
  onTopBlock,
}: {
  rows: readonly WindowedRow[];
  handle: RefObject<ScrollListHandle | null>;
  style: StyleProp<ViewStyle>;
  scrollEnabled: boolean;
  bottomInset: number;
  onTopBlock?(index: number): void;
}) {
  const scroll = useRef<NativeScrollView>(null);
  const offset = useRef(0);
  const settled = useRef(0);
  const seq = useRef(0);
  const listeners = useRef(new Set<() => void>()).current;
  const screen = useWindowDimensions();
  const [height, setHeight] = useState<number | null>(null);
  const jumpTo = useCallback((y: number): void => {
    // Rows measured before the scroll event arrives compare against where the list is going.
    offset.current = y;
    scroll.current?.scrollTo({ y, animated: false });
  }, []);
  const viewport = useMemo(
    (): Viewport => ({
      height: height ?? screen.height,
      offset: () => offset.current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      scrollTo: jumpTo,
    }),
    [height, screen.height, listeners, jumpTo],
  );
  const layout = useRowLayout(rows);
  const shift = useRef(0);
  useLayoutEffect(() => {
    if (shift.current === 0) return;
    // A row above the view grew or shrank: hold what shows in place.
    const to = offset.current + shift.current;
    shift.current = 0;
    jumpTo(to);
  });
  useImperativeHandle(
    handle,
    () => ({
      offset: () => offset.current,
      settledOffset: () => settled.current,
      scrollSeq: () => seq.current,
      topOf: layout.topOf,
      scrollTo: (y, animated) => (animated ? scroll.current?.scrollTo({ y, animated }) : jumpTo(y)),
    }),
    [layout, jumpTo],
  );
  const lastRowHeight = rows.length === 0 ? 0 : layout.tops[rows.length] - layout.tops[rows.length - 1];
  // Else a last row shorter than the view never reaches the top, so it is never reported or jumped to exactly.
  const pastEnd = onTopBlock == null ? 0 : Math.max(0, viewport.height - lastRowHeight);
  return (
    <ScrollView
      ref={scroll}
      style={style}
      scrollEnabled={scrollEnabled}
      // Else the first tap with the keyboard up only dismisses it, eating a long-press to extend a comment.
      keyboardShouldPersistTaps="handled"
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
      onScroll={(event) => {
        offset.current = event.nativeEvent.contentOffset.y;
        settled.current = offset.current;
        seq.current += 1;
        for (const listener of listeners) listener();
        const topBlock = rows[rowAt(layout.tops, offset.current)]?.blockIndex;
        if (topBlock != null) onTopBlock?.(topBlock);
      }}
      scrollEventThrottle={16}
      contentContainerStyle={{ paddingBottom: bottomInset + pastEnd }}
    >
      <ViewportContext.Provider value={viewport}>
        <Rows
          rows={rows}
          layout={layout}
          top={0}
          providesTops
          sideways={false}
          minWidth={0}
          onResize={(index, before, after) => {
            const top = layout.tops[index];
            // Strictly above: a row first measured from height 0 at the view's top is in view, not above it.
            if (top < offset.current && top + before <= offset.current) shift.current += after - before;
          }}
        />
      </ViewportContext.Provider>
    </ScrollView>
  );
}

/**
 * Rows at their full height within the enclosing `ScrollList`, mounting only those near the view. `sideways`
 * rows keep their natural width and stretch to the widest seen, for a horizontal scroll view around this.
 */
export function WindowedRows({ rows, sideways, minWidth }: { rows: readonly WindowedRow[]; sideways: boolean; minWidth: number }) {
  const layout = useRowLayout(rows);
  return (
    <Rows rows={rows} layout={layout} top={useContext(ContentTop)} providesTops={false} sideways={sideways} minWidth={minWidth} />
  );
}

interface RowLayout {
  readonly tops: Float64Array;
  readonly heights: Map<string, number>;
  remeasure(): void;
  topOf(key: string): number | null;
}

function useRowLayout(rows: readonly WindowedRow[]): RowLayout {
  const heights = useRef(new Map<string, number>()).current;
  const [measured, remeasure] = useReducer((count: number) => count + 1, 0);
  return useMemo(() => {
    const tops = new Float64Array(rows.length + 1);
    const indexes = new Map<string, number>();
    rows.forEach((row, i) => {
      indexes.set(row.key, i);
      tops[i + 1] = tops[i] + (heights.get(row.key) ?? row.estimate);
    });
    const topOf = (key: string): number | null => {
      const index = indexes.get(key);
      return index == null ? null : tops[index];
    };
    return { tops, heights, remeasure, topOf };
    // `measured` bumps when `heights` changes in place.
  }, [rows, heights, measured]);
}

function Rows({
  rows,
  layout,
  top,
  providesTops,
  sideways,
  minWidth,
  onResize,
}: {
  rows: readonly WindowedRow[];
  layout: RowLayout;
  top: number;
  providesTops: boolean;
  sideways: boolean;
  minWidth: number;
  onResize?(index: number, before: number, after: number): void;
}) {
  const viewport = useContext(ViewportContext);
  const { tops, heights, remeasure } = layout;
  const total = tops[rows.length];
  const band = useBand(viewport, top, total);
  const [widest, setWidest] = useState(0);
  const pinned = useMemo(() => rows.flatMap((row, i) => (row.pinned ? [i] : [])), [rows]);
  const first = rowAt(tops, band - viewport.height);
  const last = rowAt(tops, band + 2 * viewport.height);
  const shown = [
    ...pinned.filter((i) => i < first),
    ...range(first, Math.min(last, rows.length - 1)),
    ...pinned.filter((i) => i > last),
  ];
  const width = sideways ? Math.max(widest, minWidth) : undefined;
  return (
    <View style={{ height: total, width }}>
      {shown.map((i) => {
        const row = rows[i];
        const content = row.render();
        return (
          <View
            key={row.key}
            style={{ position: "absolute", top: tops[i], left: 0, ...(sideways ? { minWidth: width } : { right: 0 }) }}
            onLayout={(event) => {
              const measured = event.nativeEvent.layout;
              if (sideways) setWidest((current) => Math.max(current, measured.width));
              const before = heights.get(row.key) ?? row.estimate;
              heights.set(row.key, measured.height);
              if (before === measured.height) return;
              onResize?.(i, before, measured.height);
              remeasure();
            }}
          >
            {providesTops ? <ContentTop.Provider value={top + tops[i]}>{content}</ContentTop.Provider> : content}
          </View>
        );
      })}
    </View>
  );
}

function useBand(viewport: Viewport, top: number, total: number): number {
  // Coarse steps, inside the overscan: re-renders a few times a screenful, not every frame.
  const step = Math.max(1, viewport.height / 2);
  return useSyncExternalStore(viewport.subscribe, () => {
    const within = Math.min(Math.max(viewport.offset() - top, -viewport.height), total);
    return Math.floor(within / step) * step;
  });
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}

function rowAt(tops: Float64Array, y: number): number {
  if (tops.length < 2) return 0;
  let low = 0;
  let high = tops.length - 2;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (tops[mid] <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}
