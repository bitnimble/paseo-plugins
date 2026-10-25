import { Platform } from "react-native";
import type { MonacoAsset } from "../shared/protocol";
import type { CodeEditor, EditorContainer, Monaco } from "./monaco/api";
import { MONOSPACE } from "./palette";

// This plugin typechecks without the DOM library.
interface ElementNode {
  textContent: string;
  classList: { add(name: string): void };
}

interface ScriptElement {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

interface AmdRequire {
  (modules: readonly string[], onLoad: (...modules: unknown[]) => void, onError: (error: unknown) => void): void;
}

declare const document: {
  createElement(tagName: "script"): ScriptElement;
  createElement(tagName: "style" | "div"): ElementNode;
  head: { appendChild(element: ScriptElement | ElementNode): void };
  documentElement: { classList: { toggle(name: string, force: boolean): void } };
};

declare const window: {
  require?: AmdRequire;
  MonacoEnvironment?: { getWorker(): unknown };
  matchMedia?(query: string): { matches: boolean };
};

interface QueryNode {
  readonly style: { top: string; visibility: string };
  readonly parentElement: QueryNode | null;
  querySelectorAll(selector: string): Iterable<QueryNode>;
}

declare class MutationObserver {
  constructor(callback: () => void);
  observe(
    target: QueryNode,
    options: { childList: boolean; subtree: boolean; attributes: boolean; attributeFilter: readonly string[] },
  ): void;
  disconnect(): void;
}

interface WheelLike {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly shiftKey: boolean;
  preventDefault(): void;
}

interface WheelTarget {
  addEventListener(type: "wheel", listener: (event: WheelLike) => void, options: { passive: boolean }): void;
  removeEventListener(type: "wheel", listener: (event: WheelLike) => void): void;
}

declare class Blob {
  constructor(parts: readonly string[], options: { type: string });
}
declare const URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
declare class Worker {
  constructor(url: string);
}

const EXTRA_CSS = `
.review-comment-glyph { cursor: pointer; opacity: 0.8; }
.review-comment-glyph:hover { opacity: 1; }
[data-reviewresize] { cursor: col-resize; }
.margin-view-overlays .insert-sign:not(.review-sign), .margin-view-overlays .delete-sign:not(.review-sign) { display: none !important; }
.review-scope, .review-scope-margin {
  box-sizing: border-box;
  background-color: var(--vscode-editor-rangeHighlightBackground);
  border: 0 solid var(--vscode-editor-rangeHighlightBorder);
}
.review-scope { border-right-width: 1px; }
.review-scope-margin { border-left-width: 1px; }
.review-scope-first { border-top-width: 1px; }
.review-scope-last { border-bottom-width: 1px; }
.review-resizing, .review-resizing * { user-select: none !important; cursor: col-resize !important; }
[data-reviewcards] { overflow: clip !important; }
[data-reviewsticky] { position: sticky !important; top: 0; }
.monaco-editor .reference-zone-widget .ref-tree { font-family: var(--paseo-ui-font, inherit); font-size: 12px; }
.monaco-editor .reference-zone-widget .ref-tree .reference { font-family: ${MONOSPACE}; }
`;

/** Holds the resize cursor, and stops text selection, wherever the pointer wanders mid-drag. */
export function markResizing(resizing: boolean): void {
  if (Platform.OS === "web") document.documentElement.classList.toggle("review-resizing", resizing);
}

/** Monaco is mouse-and-keyboard software: phones and tablets get the built-in renderer. */
export function isMonacoSupported(): boolean {
  return hasMouse();
}

export function hasMouse(): boolean {
  return Platform.OS === "web" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === true;
}

export function asEditorContainer(node: object): EditorContainer {
  return node as unknown as EditorContainer;
}

/** Keeps the `−` of a wrapped deleted line on its first row only, in a unified diff editor's deleted-line zones. */
export function signFirstDeletedRows(container: object): () => void {
  const root = container as unknown as QueryNode;
  const update = (): void => {
    const zones = [...root.querySelectorAll(".inline-deleted-margin-view-zone")];
    if (zones.length === 0) return;
    // The original editor shows only a line-number column here, numbering each line on its first row.
    const starts = new Set<number>();
    for (const number of root.querySelectorAll(".editor.original .margin-view-overlays .line-numbers")) {
      starts.add(parseFloat(number.parentElement?.style.top ?? ""));
    }
    for (const zone of zones) {
      const zoneTop = parseFloat(zone.style.top);
      for (const sign of zone.querySelectorAll(".delete-sign")) {
        const visibility = starts.has(zoneTop + parseFloat(sign.style.top)) ? "" : "hidden";
        // Unchanged writes would requeue the observer forever.
        if (sign.style.visibility !== visibility) sign.style.visibility = visibility;
      }
    }
  };
  const observer = new MutationObserver(update);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  update();
  return () => observer.disconnect();
}

/** Scrolls an editor that ignores the wheel sideways, for a horizontal or shift-held wheel over `container`; returns a stop. */
export function scrollSidewaysOnWheel(container: object, editor: CodeEditor): () => void {
  // Not the editor's own node: Monaco replaces that on every model swap.
  const node = container as unknown as WheelTarget;
  const onWheel = (event: WheelLike): void => {
    const sideways = event.shiftKey
      ? event.deltaX || event.deltaY
      : Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : 0;
    if (sideways === 0) return;
    editor.setScrollLeft(editor.getScrollLeft() + sideways);
    event.preventDefault();
  };
  node.addEventListener("wheel", onWheel, { passive: false });
  return () => node.removeEventListener("wheel", onWheel);
}

/** Monaco styles overflow widgets through an ancestor carrying its root class. */
export function asOverflowHost(node: object): EditorContainer {
  (node as unknown as ElementNode).classList.add("monaco-editor");
  return asEditorContainer(node);
}

export function createDetachedNode(): EditorContainer {
  return asEditorContainer(document.createElement("div"));
}

/** Runs Monaco's AMD build from text, since the plugin's files are not served over HTTP. */
export async function injectMonaco(read: (asset: MonacoAsset) => Promise<string>): Promise<Monaco> {
  if (!isMonacoSupported()) {
    throw new Error("Monaco runs only in the Paseo web and desktop apps on a computer.");
  }
  const loaded = await requireMonaco().catch(() => null);
  if (loaded != null) return loaded;
  const [script, css, worker] = await Promise.all([read("script"), read("css"), read("worker")]);
  const style = document.createElement("style");
  style.textContent = css + EXTRA_CSS;
  document.head.appendChild(style);
  // The official AMD entry wraps its worker the same way: it reports ready once its code has run.
  const workerUrl = blobUrl(`${worker}\nglobalThis.postMessage({ type: "vscode-worker-ready" });`);
  window.MonacoEnvironment = { getWorker: () => new Worker(workerUrl) };
  const scriptUrl = blobUrl(script);
  try {
    await loadScript(scriptUrl);
  } finally {
    URL.revokeObjectURL(scriptUrl);
  }
  return await requireMonaco();
}

function requireMonaco(): Promise<Monaco> {
  const loader = window.require;
  if (loader == null) {
    return Promise.reject(new Error("The Monaco AMD loader is not installed."));
  }
  return new Promise<Monaco>((resolve, reject) => {
    loader(["review-assist/monaco"], (monaco) => resolve(monaco as Monaco), reject);
  });
}

function blobUrl(text: string): string {
  return URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not run Monaco; is a blob: script blocked by a Content-Security-Policy?"));
    document.head.appendChild(script);
  });
}
