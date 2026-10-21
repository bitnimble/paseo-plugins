import type { MonacoAsset } from "../shared/protocol";
import css from "./monaco/editor.css.txt";
import script from "./monaco/editor.js.txt";
import worker from "./monaco/worker.js.txt";

const ASSETS: Readonly<Record<MonacoAsset, string>> = { script, css, worker };
const CHUNK_CHARS = 512 * 1024;

export function monacoChunk(asset: MonacoAsset, offset: number): { text: string; total: number } {
  const text = ASSETS[asset];
  return { text: text.slice(offset, offset + CHUNK_CHARS), total: text.length };
}
