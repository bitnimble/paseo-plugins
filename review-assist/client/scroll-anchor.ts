import { useEffect, useRef } from "react";
import { z } from "zod";

// This plugin typechecks without the DOM library; both are absent on native.
declare const document:
  | undefined
  | {
      visibilityState: string;
      addEventListener(type: "visibilitychange", listener: () => void): void;
      removeEventListener(type: "visibilitychange", listener: () => void): void;
    };
declare const window: {
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
};

export const scrollAnchorSchema = z.object({ section: z.number().int().optional(), path: z.string() });
export type ScrollAnchor = z.infer<typeof scrollAnchorSchema>;

export const SCROLL_PERSIST_MS = 500;

export function useDebouncedCallback<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<T | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  const flush = useRef((): void => {
    if (pending.current == null) return;
    clearTimeout(timer.current);
    const args = pending.current;
    pending.current = null;
    latest.current(...args);
  });
  useEffect(() => {
    // A webview teardown within the debounce window would otherwise drop the last scroll anchor.
    const doc = document;
    if (doc == null) return () => flush.current();
    const onHide = (): void => {
      if (doc.visibilityState === "hidden") flush.current();
    };
    doc.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      doc.removeEventListener("visibilitychange", onHide);
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
