import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { z } from "zod";

// This plugin typechecks without the DOM library.
declare const document: {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};
declare const window: {
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
};

export const scrollAnchorSchema = z.object({
  section: z.number().int().optional(),
  path: z.string(),
  /** How far past the top of the file's block the view's top was. */
  within: z.number().optional(),
});
export type ScrollAnchor = z.infer<typeof scrollAnchorSchema>;

export const SCROLL_PERSIST_MS = 500;

export function useRestoreGate(key: unknown): { markRestored: () => void; hasRestored: () => boolean } {
  const done = useRef(false);
  const seen = useRef(key);
  // Reset in render, not an effect: a child's onRestored effect runs before a parent effect and would be clobbered.
  if (seen.current !== key) {
    seen.current = key;
    done.current = false;
  }
  return {
    markRestored: () => {
      done.current = true;
    },
    hasRestored: () => done.current,
  };
}

/** A call still pending when `key` changes is dropped: it was made about what `key` replaced. */
export function useDebouncedCallback<T extends unknown[]>(
  fn: (...args: T) => void,
  ms: number,
  key: unknown,
): (...args: T) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<T | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  const seen = useRef(key);
  if (seen.current !== key) {
    seen.current = key;
    clearTimeout(timer.current);
    pending.current = null;
  }
  const flush = useRef((): void => {
    if (pending.current == null) return;
    clearTimeout(timer.current);
    const args = pending.current;
    pending.current = null;
    latest.current(...args);
  });
  useEffect(() => {
    // A webview teardown within the debounce window would otherwise drop the last scroll anchor.
    if (Platform.OS !== "web") return () => flush.current();
    const onHide = (): void => {
      if (document.visibilityState === "hidden") flush.current();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      flush.current();
    };
  }, []);
  return (...args: T) => {
    pending.current = args;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      latest.current(...args);
    }, ms);
  };
}
