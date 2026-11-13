import { isAbsolute, join, relative, sep } from "node:path";
import { type LspPosition, type LspRange, toHoverMarkdown, toLocations } from "../../shared/lsp";
import type { LineTokens, PeekLocation, PeekOutcome } from "../../shared/protocol";
import { highlightFile } from "../highlight";
import type { TreeFiles } from "../trees";
import { type LanguageServers, filePathOf } from "./pool";

const MAX_LOCATIONS = 8;
const LINES_ABOVE = 2;
const PEEK_LINES = 14;
const MAX_LINE_CHARS = 1_000;

interface PeekFile {
  readonly lines: readonly string[];
  readonly tokens: LineTokens | null;
}

export async function peek(
  servers: LanguageServers,
  trees: TreeFiles,
  at: { root: string; tree: string; path: string; position: LspPosition },
): Promise<PeekOutcome> {
  const { root, tree, path, position } = at;
  const ask = (method: string) => servers.request({ root, tree, path, method, params: { position } });
  const [definition, hover] = await Promise.all([ask("textDocument/definition"), ask("textDocument/hover")]);
  if (definition.status !== "ok") return definition;
  const files = new Map<string, Promise<PeekFile | null>>();
  const fileAt = (absolute: string): Promise<PeekFile | null> => {
    let file = files.get(absolute);
    if (file == null) {
      file = readPeekFile(
        absolute === join(root, path)
          ? // The server answered from the text synced at this tree, which may not match the disk.
            trees.read(root, tree, path)
          : servers.readFile(root, absolute),
        absolute,
      );
      files.set(absolute, file);
    }
    return file;
  };
  const locations = await Promise.all(
    toLocations(definition.result)
      .slice(0, MAX_LOCATIONS)
      .map((location) => excerpt(root, location, fileAt)),
  );
  return {
    status: "ok",
    hover: hover.status === "ok" ? (toHoverMarkdown(hover.result)?.markdown ?? null) : null,
    locations: locations.filter((location) => location != null),
  };
}

async function excerpt(
  root: string,
  { uri, range }: { uri: string; range: LspRange },
  fileAt: (absolute: string) => Promise<PeekFile | null>,
): Promise<PeekLocation | null> {
  const absolute = filePathOf(uri);
  if (absolute == null) return null;
  const file = await fileAt(absolute);
  if (file == null) return null;
  const { lines, tokens } = file;
  const first = Math.max(0, Math.min(range.start.line - LINES_ABOVE, lines.length - PEEK_LINES));
  const end = Math.min(lines.length, first + PEEK_LINES);
  const inside = relative(root, absolute);
  const outside = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  return {
    path: outside ? absolute : inside,
    range,
    first,
    lines: lines.slice(first, end).map((line) => line.slice(0, MAX_LINE_CHARS)),
    tokens: tokens?.slice(first, end) ?? null,
  };
}

async function readPeekFile(reading: Promise<string>, absolute: string): Promise<PeekFile | null> {
  const read = await reading.catch(() => null);
  if (read == null) return null;
  const text = read.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  let tokens: LineTokens | null = null;
  try {
    tokens = highlightFile(text, absolute);
  } catch {
    // Unhighlighted beats no peek.
  }
  return { lines, tokens };
}
