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
import {
  Animated,
  type NativeScrollEvent,
  type ScrollView as NativeScrollView,
  type NativeSyntheticEvent,
  Platform,
  type StyleProp,
  View,
  type ViewStyle,
  useWindowDimensions,
} from "react-native";

const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

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
  /** The furthest the list scrolls, with the rows measured so far. */
  maxOffset(): number;
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

/** How much stays pinned over the view's top, on the web, while content rendered here scrolls under it. */
export const PinnedHeight = createContext(0);

/**
 * The list's scroll position, followed on the native thread for transforms that track it without lagging a
 * frame; content sits `held` higher than it, mid-fling.
 */
export const ScrollPosition = createContext<{ readonly y: Animated.Value; readonly held: number } | null>(null);

type PinnedStyle = { transform: { translateY: Animated.AnimatedInterpolation<number> }[] };

/**
 * On native, holds content starting at `top` against the view's top, for up to `travel` of scrolling: the web's
 * `STICKY` does it there.
 */
export function usePinnedAtTop(top: number, travel: number): PinnedStyle | null {
  const position = useContext(ScrollPosition);
  return useMemo(() => {
    if (Platform.OS === "web" || position == null || travel <= 0) return null;
    const start = top - position.held;
    const translateY = position.y.interpolate({
      inputRange: [start, start + travel],
      outputRange: [0, travel],
      extrapolate: "clamp",
    });
    return { transform: [{ translateY }] };
  }, [position, top, travel]);
}

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
  const momentum = useRef(false);
  const held = useRef(0);
  const [shownHeld, setShownHeld] = useState(0);
  const released = useRef(false);
  const jumpTo = useCallback((y: number): void => {
    // Rows measured before the scroll event arrives compare against where the list is going.
    offset.current = y;
    // A jump ends any fling, without the momentum-end event to say so.
    momentum.current = false;
    held.current = 0;
    setShownHeld(0);
    scroll.current?.scrollTo({ y, animated: false });
  }, []);
  const release = (): void => {
    momentum.current = false;
    if (held.current === 0) return;
    held.current = 0;
    released.current = true;
    setShownHeld(0);
  };
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
    if (shift.current === 0 && !released.current) return;
    // A row above the view grew or shrank: hold what shows in place.
    const to = offset.current + shift.current;
    shift.current = 0;
    released.current = false;
    jumpTo(to);
  });
  const maxOffset = (): number => Math.max(0, layout.tops[rows.length] + bottomInset - viewport.height);
  useImperativeHandle(handle, () => ({
    offset: () => offset.current,
    settledOffset: () => settled.current,
    scrollSeq: () => seq.current,
    topOf: layout.topOf,
    maxOffset,
    scrollTo: (y, animated) => (animated ? scroll.current?.scrollTo({ y: y - held.current, animated }) : jumpTo(y)),
  }));
  const handleScroll = useRef((_event: NativeSyntheticEvent<NativeScrollEvent>): void => undefined);
  handleScroll.current = (event) => {
    offset.current = event.nativeEvent.contentOffset.y + held.current;
    settled.current = offset.current;
    seq.current += 1;
    for (const listener of listeners) listener();
    const end = maxOffset();
    const atEnd = end > 0 && offset.current >= end - 1;
    const topBlock = atEnd ? lastBlock(rows) : rows[rowAt(layout.tops, offset.current)]?.blockIndex;
    if (topBlock != null) onTopBlock?.(topBlock);
  };
  const scrollY = useRef(new Animated.Value(0)).current;
  const onScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: Platform.OS !== "web",
        listener: (event: NativeSyntheticEvent<NativeScrollEvent>) => handleScroll.current(event),
      }),
    [scrollY],
  );
  const position = useMemo(() => ({ y: scrollY, held: shownHeld }), [scrollY, shownHeld]);
  return (
    <AnimatedScrollView
      ref={scroll}
      style={style}
      scrollEnabled={scrollEnabled}
      // Else the first tap with the keyboard up only dismisses it, eating a long-press to extend a comment.
      keyboardShouldPersistTaps="handled"
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
      onMomentumScrollBegin={() => {
        momentum.current = true;
      }}
      onMomentumScrollEnd={release}
      onScrollBeginDrag={release}
      onScroll={onScroll}
      scrollEventThrottle={16}
      contentContainerStyle={{ paddingBottom: bottomInset }}
    >
      <ScrollPosition.Provider value={position}>
        <ViewportContext.Provider value={viewport}>
          <View style={shownHeld === 0 ? undefined : { transform: [{ translateY: -shownHeld }] }}>
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
                if (top >= offset.current) return;
                if (top + before > offset.current) {
                  // A row holding the view's top shrank above it, as a file collapsed from its pinned header.
                  if (top + after <= offset.current) shift.current += top - offset.current;
                  return;
                }
                const grew = after - before;
                if (!momentum.current) {
                  shift.current += grew;
                  return;
                }
                // scrollTo mid-fling stops the fling dead: offset the content instead, until it settles.
                held.current += grew;
                offset.current += grew;
                setShownHeld(held.current);
              }}
            />
          </View>
        </ViewportContext.Provider>
      </ScrollPosition.Provider>
    </AnimatedScrollView>
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

/** At the list's end, as a last block shorter than the view never reaches its top. */
function lastBlock(rows: readonly WindowedRow[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].blockIndex != null) return rows[i].blockIndex;
  }
  return undefined;
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
