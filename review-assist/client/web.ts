import { Platform } from "react-native";
import type { MonacoAsset } from "../shared/protocol";
import type { EditorContainer, Monaco } from "./monaco/api";
import { MONOSPACE } from "./palette";

// This plugin typechecks without the DOM library. Declare only what this module uses.
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
};

declare const window: {
  require?: AmdRequire;
  MonacoEnvironment?: { getWorker(): unknown };
  matchMedia?(query: string): { matches: boolean };
};

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
.monaco-editor .reference-zone-widget .ref-tree { font-family: var(--paseo-ui-font, inherit); font-size: 12px; }
.monaco-editor .reference-zone-widget .ref-tree .reference { font-family: ${MONOSPACE}; }
`;

/** Monaco is mouse-and-keyboard software: phones and tablets get the built-in renderer. */
export function isMonacoSupported(): boolean {
  return Platform.OS === "web" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === true;
}

export function asEditorContainer(node: object): EditorContainer {
  return node as unknown as EditorContainer;
}

/** Monaco styles overflow widgets through an ancestor carrying its root class. */
export function asOverflowHost(node: object): EditorContainer {
  (node as unknown as ElementNode).classList.add("monaco-editor");
  return asEditorContainer(node);
}

export function createZoneNode(): EditorContainer {
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
