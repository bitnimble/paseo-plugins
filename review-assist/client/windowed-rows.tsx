import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useMemo, useReducer, useRef, useState } from "react";
import { View } from "react-native";

export interface WindowedRow {
  readonly key: string;
  /** Kept mounted while scrolled away, for state such as a comment being typed. */
  readonly pinned: boolean;
  render(): ReactNode;
}

/**
 * Rows in a scroll view at most `maxHeight` tall, mounting only those near the view. `sideways` rows
 * keep their natural width and stretch to the widest seen, for a horizontal scroll view around this.
 */
export function WindowedRows({
  rows,
  estimate,
  maxHeight,
  sideways,
  minWidth,
}: {
  rows: readonly WindowedRow[];
  estimate: number;
  maxHeight: number;
  sideways: boolean;
  minWidth: number;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const heights = useRef(new Map<string, number>()).current;
  const [measured, remeasure] = useReducer((count: number) => count + 1, 0);
  const [widest, setWidest] = useState(0);
  const tops = useMemo(() => {
    const offsets = new Float64Array(rows.length + 1);
    rows.forEach((row, i) => {
      offsets[i + 1] = offsets[i] + (heights.get(row.key) ?? estimate);
    });
    return offsets;
    // `measured` bumps when `heights` changes in place.
  }, [rows, estimate, heights, measured]);
  const pinned = useMemo(() => rows.flatMap((row, i) => (row.pinned ? [i] : [])), [rows]);
  const first = rowAt(tops, scrollTop - maxHeight);
  const last = rowAt(tops, scrollTop + 2 * maxHeight);
  const shown = [
    ...pinned.filter((i) => i < first),
    ...range(first, Math.min(last, rows.length - 1)),
    ...pinned.filter((i) => i > last),
  ];
  const width = sideways ? Math.max(widest, minWidth) : undefined;
  // Coarse steps, inside the overscan: re-renders a few times a screenful, not every frame.
  const step = Math.max(1, maxHeight / 2);
  return (
    <ScrollView
      style={{ maxHeight }}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      onScroll={(event) => setScrollTop(Math.floor(event.nativeEvent.contentOffset.y / step) * step)}
      scrollEventThrottle={16}
    >
      <View style={{ height: tops[rows.length], width }}>
        {shown.map((i) => {
          const { key } = rows[i];
          return (
            <View
              key={key}
              style={{ position: "absolute", top: tops[i], left: 0, ...(sideways ? { minWidth: width } : { right: 0 }) }}
              onLayout={(event) => {
                const layout = event.nativeEvent.layout;
                if (sideways) setWidest((current) => Math.max(current, layout.width));
                const before = heights.get(key) ?? estimate;
                heights.set(key, layout.height);
                if (before !== layout.height) remeasure();
              }}
            >
              {rows[i].render()}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
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
