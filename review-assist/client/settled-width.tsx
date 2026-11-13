import { type ReactNode, useEffect, useRef, useState } from "react";
import { View } from "react-native";

const SETTLE_MS = 400;

/** Fills its parent, laying `children` out at the parent's width at once, then only as a run of resizes pauses. */
export function SettledWidth({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resizing = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <View
      style={{ flex: 1, overflow: "hidden" }}
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;
        clearTimeout(timer.current);
        if (width == null || width === 0 || !resizing.current) setWidth(next);
        // Every Monaco editor relays and rewraps on a width change: following each frame of a drag lags it.
        resizing.current = true;
        timer.current = setTimeout(() => {
          resizing.current = false;
          setWidth(next);
        }, SETTLE_MS);
      }}
    >
      <View style={{ flex: 1, width: width ?? undefined }}>{children}</View>
    </View>
  );
}
