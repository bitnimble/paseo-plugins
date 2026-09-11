import { Platform } from "react-native";
import type { EditorContainer, Monaco } from "./monaco-api";

const MONACO_BASE = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface ScriptElement {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

interface AmdLoader {
  (modules: readonly string[], onLoad: () => void): void;
  config(options: { paths: Record<string, string> }): void;
}

declare const document: {
  createElement(tagName: "script"): ScriptElement;
  head: { appendChild(element: ScriptElement): void };
};

declare const window: {
  monaco?: Monaco;
  require?: AmdLoader;
  MonacoEnvironment?: { getWorkerUrl(moduleId: string, label: string): string };
  URL: { createObjectURL(blob: object): string };
  Blob: new (parts: readonly string[], options: { type: string }) => object;
};

let loading: Promise<Monaco> | null = null;

export function isEditorSupported(): boolean {
  return Platform.OS === "web";
}

export function loadMonaco(): Promise<Monaco> {
  loading ??= injectMonaco();
  return loading;
}

export function asEditorContainer(node: object): EditorContainer {
  return node as unknown as EditorContainer;
}

async function injectMonaco(): Promise<Monaco> {
  if (!isEditorSupported()) {
    throw new Error("The editor runs only in the Paseo web and desktop apps.");
  }
  if (window.monaco != null) {
    return window.monaco;
  }

  window.MonacoEnvironment = { getWorkerUrl: crossOriginWorkerUrl };
  await loadScript(`${MONACO_BASE}vs/loader.js`);

  const loader = window.require;
  if (loader == null) {
    throw new Error("The Monaco AMD loader did not install itself.");
  }
  loader.config({ paths: { vs: `${MONACO_BASE}vs` } });
  await new Promise<void>((resolve) => {
    // Leave window.require in place: Monaco fetches each Monarch grammar through it on first use.
    loader(["vs/editor/editor.main"], resolve);
  });

  const monaco = window.monaco;
  if (monaco == null) {
    throw new Error("Monaco loaded without publishing its API.");
  }
  return monaco;
}

function crossOriginWorkerUrl(): string {
  const proxy = `self.MonacoEnvironment={baseUrl:"${MONACO_BASE}"};importScripts("${MONACO_BASE}vs/base/worker/workerMain.js");`;
  return window.URL.createObjectURL(new window.Blob([proxy], { type: "text/javascript" }));
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}
