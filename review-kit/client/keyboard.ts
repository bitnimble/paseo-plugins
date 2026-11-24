import { type RefObject, createContext, useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, Platform, type View } from "react-native";
import { hasMouse } from "./web";

declare const window: { innerHeight: number; visualViewport?: VisualViewport | null };

interface VisualViewport {
  readonly offsetTop: number;
  readonly height: number;
  readonly scale: number;
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

export interface Span {
  readonly top: number;
  readonly bottom: number;
}

const KEYBOARD_WAIT_MS = 600;
const RESIZE_SETTLE_MS = 150;
const MIN_KEYBOARD_HEIGHT = 120;

/** Scrolls `node` to the middle of what the soft keyboard leaves visible; returns a cancel. */
export const CentreAboveKeyboard = createContext<(node: View) => () => void>(() => () => undefined);

export interface Scroller {
  offset(): number;
  scrollTo(y: number, animated: boolean): void;
}

/**
 * The `CentreAboveKeyboard` for a list scrolled by `scroller` inside `frame`, and the space to pad
 * its end with so the last comment can centre too; `open` is whether a comment is open.
 */
export function useCentreAboveKeyboard(
  frame: RefObject<View | null>,
  scroller: RefObject<Scroller | null>,
  open: boolean,
): { centre: (node: View) => () => void; bottomInset: number } {
  const [keyboardInset, setKeyboardInset] = useState(0);
  const bottomInset = open ? keyboardInset : 0;
  const latestInset = useRef(bottomInset);
  latestInset.current = bottomInset;
  const pendingScroll = useRef<number | null>(null);
  const scrollToPending = useCallback(() => {
    if (pendingScroll.current == null) return;
    scroller.current?.scrollTo(pendingScroll.current, true);
    pendingScroll.current = null;
  }, [scroller]);
  const centre = useCallback(
    (node: View) => {
      let live = true;
      const stop = afterKeyboard(async (visible) => {
        if (frame.current == null) return;
        const [shown, target] = await Promise.all([spanOf(frame.current), spanOf(node)]);
        if (!live) return;
        const { scroll, bottomInset: inset } = centring(shown, target, visible);
        pendingScroll.current = Math.max(0, (scroller.current?.offset() ?? 0) + scroll);
        // The effect on the inset scrolls once the space is laid out.
        if (inset === latestInset.current) scrollToPending();
        else setKeyboardInset(inset);
      });
      return () => {
        live = false;
        stop();
      };
    },
    [frame, scroller, scrollToPending],
  );
  useEffect(scrollToPending, [bottomInset, scrollToPending]);
  return { centre, bottomInset };
}

/**
 * Calls `then` with the part of the window the soft keyboard leaves visible, once it has opened or
 * none has; never on a computer. Returns a cancel.
 */
export function afterKeyboard(then: (visible: Span) => void): () => void {
  if (Platform.OS !== "web") return nativeKeyboard(then);
  const viewport = window.visualViewport;
  return viewport == null || hasMouse() ? () => undefined : webKeyboard(viewport, then);
}

/**
 * How far to scroll `list` down to centre `target` in the part of it `visible` covers, and the
 * space `list` needs below its content for that when `target` ends it.
 */
export function centring(list: Span, target: Span, visible: Span): { scroll: number; bottomInset: number } {
  const top = Math.max(list.top, visible.top);
  const bottom = Math.min(list.bottom, visible.bottom);
  const height = target.bottom - target.top;
  const landed = height > bottom - top ? top : (top + bottom - height) / 2;
  return { scroll: target.top - landed, bottomInset: Math.max(0, list.bottom - landed - height) };
}

export function spanOf(view: View): Promise<Span> {
  return new Promise((resolve) => view.measureInWindow((_x, y, _width, height) => resolve({ top: y, bottom: y + height })));
}

function nativeKeyboard(then: (visible: Span) => void): () => void {
  const open = Keyboard.metrics();
  if (Keyboard.isVisible() && open != null) {
    then({ top: 0, bottom: open.screenY });
    return () => undefined;
  }
  const shown = Keyboard.addListener("keyboardDidShow", (event) => {
    stop();
    then({ top: 0, bottom: event.endCoordinates.screenY });
  });
  const timer = setTimeout(() => {
    stop();
    then({ top: 0, bottom: Infinity });
  }, KEYBOARD_WAIT_MS);
  function stop(): void {
    shown.remove();
    clearTimeout(timer);
  }
  return stop;
}

function webKeyboard(viewport: VisualViewport, then: (visible: Span) => void): () => void {
  const visible = () => ({ top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height });
  // Only a keyboard overlaying the page shows as open: one that resizes it shrinks innerHeight too.
  if (window.innerHeight - viewport.height * viewport.scale >= MIN_KEYBOARD_HEIGHT) {
    then(visible());
    return () => undefined;
  }
  const done = () => {
    stop();
    then(visible());
  };
  let wait = setTimeout(done, KEYBOARD_WAIT_MS);
  const onResize = () => {
    clearTimeout(wait);
    wait = setTimeout(done, RESIZE_SETTLE_MS);
  };
  viewport.addEventListener("resize", onResize);
  function stop(): void {
    viewport.removeEventListener("resize", onResize);
    clearTimeout(wait);
  }
  return stop;
}
