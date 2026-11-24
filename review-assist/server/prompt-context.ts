import { getParserForFile } from "@getpaseo/highlight";
import type { DiffFile, DiffHunk, ParsedDiff } from "../kit/shared/diff";
import { mapLimit } from "./map-limit";

export type ContextSide = "old" | "new";

export interface ContextLine {
  /** 1-based, on the hunk's `side`, like `DiffLine` numbers. */
  readonly number: number;
  readonly text: string;
}

export interface HunkContext {
  readonly side: ContextSide;
  /** Header lines of the declarations enclosing the hunk, in file order. */
  readonly scope: readonly ContextLine[];
  readonly before: readonly ContextLine[];
  readonly after: readonly ContextLine[];
}

export type PromptContext = ReadonlyMap<string, HunkContext>;

export interface PromptContextOptions {
  readonly lines: number;
  readonly scope: boolean;
}

export type ReadSide = (side: ContextSide, path: string) => Promise<string>;

type Tree = ReturnType<NonNullable<ReturnType<typeof getParserForFile>>["parse"]>;
type SyntaxNode = ReturnType<Tree["resolveInner"]>;

const SCOPE_NODE = /(?:Declaration|Definition|Decl|Item|Specifier)$|^Property$/;
const HEADER_PREAMBLE = /^(?:Decorator|Modifiers|Annotation|MarkerAnnotation)$/;
const MAX_SCOPE_HEADER_LINES = 3;
const MAX_PARSED_CHARS = 2_000_000;
const MAX_PARALLEL_FILES = 8;

/**
 * Context lines may repeat between hunks of a file; the prompt leaves out any already shown.
 * Files that can't be read or parsed get no context, and languages without a syntax tree no scope.
 */
export async function readPromptContext(
  diff: ParsedDiff,
  read: ReadSide,
  options: PromptContextOptions,
): Promise<PromptContext> {
  const context = new Map<string, HunkContext>();
  if (options.lines === 0 && !options.scope) return context;
  await mapLimit(diff.files, MAX_PARALLEL_FILES, async (file) => {
    if (file.generated || file.binary || file.hunks.length === 0) return;
    const side = file.newPath == null ? "old" : "new";
    const path = side === "new" ? file.newPath : file.oldPath;
    if (path == null) return;
    try {
      const text = await read(side, path);
      const tree = options.scope ? parse(path, text) : null;
      for (const [hunkId, hunkContext] of fileContext(file, side, new Source(text), tree, options.lines)) {
        context.set(hunkId, hunkContext);
      }
    } catch {
      return;
    }
  });
  return context;
}

function parse(path: string, text: string): Tree | null {
  if (text.length > MAX_PARSED_CHARS) return null;
  return getParserForFile(path)?.parse(text) ?? null;
}

function fileContext(
  file: DiffFile,
  side: ContextSide,
  source: Source,
  tree: Tree | null,
  contextLines: number,
): Map<string, HunkContext> {
  const spans = file.hunks.map((hunk) => spanOf(hunk, side));
  const nextStarts: number[] = new Array(spans.length);
  let nextStart = source.lines.length;
  for (let index = spans.length - 1; index >= 0; index--) {
    nextStarts[index] = nextStart;
    nextStart = spans[index]?.start ?? nextStart;
  }
  const lineAt = (index: number): ContextLine => ({ number: index + 1, text: source.lines[index] });
  const context = new Map<string, HunkContext>();
  let previousEnd = 0;
  file.hunks.forEach((hunk, index) => {
    const span = spans[index];
    if (span == null) return;
    const beforeStart = Math.max(previousEnd, span.start - contextLines);
    const afterEnd = Math.min(nextStarts[index], span.end + contextLines);
    const scope = tree == null ? [] : enclosingScope(tree, source, span).filter((line) => line < beforeStart);
    context.set(hunk.id, {
      side,
      scope: scope.map(lineAt),
      before: range(beforeStart, span.start).map(lineAt),
      after: range(span.end, afterEnd).map(lineAt),
    });
    previousEnd = span.end;
  });
  return context;
}

/** Zero-based, end exclusive; null when the hunk has no lines on `side`. */
function spanOf(hunk: DiffHunk, side: ContextSide): { start: number; end: number } | null {
  const numbers = hunk.lines.flatMap((line) => {
    const number = side === "new" ? line.newNumber : line.oldNumber;
    return number == null ? [] : [number];
  });
  if (numbers.length === 0) return null;
  return { start: numbers[0] - 1, end: numbers[numbers.length - 1] };
}

function enclosingScope(tree: Tree, source: Source, span: { start: number; end: number }): number[] {
  const line = source.lines.slice(span.start, span.end).findIndex((text) => text.trim() !== "");
  if (line < 0) return [];
  const target = span.start + line;
  const headers = new Set<number>();
  let child: SyntaxNode | null = null;
  for (let node: SyntaxNode | null = tree.resolveInner(source.codeStart(target), 1); node != null; node = node.parent) {
    const inner = child;
    child = node;
    if (!SCOPE_NODE.test(node.name)) continue;
    const first = source.lineAt(headerStart(node));
    if (first >= target) continue;
    const bodyLine = inner == null ? target : source.lineAt(inner.from);
    const bodyOwnsLine = bodyLine > first && (inner == null || inner.from === source.codeStart(bodyLine));
    const last = Math.min(bodyOwnsLine ? bodyLine - 1 : bodyLine, target - 1, first + MAX_SCOPE_HEADER_LINES - 1);
    for (let header = first; header <= last; header++) headers.add(header);
  }
  return [...headers].sort((a, b) => a - b);
}

function headerStart(node: SyntaxNode): number {
  let part = node.firstChild;
  while (part != null && HEADER_PREAMBLE.test(part.name)) part = part.nextSibling;
  return part?.from ?? node.from;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
}

class Source {
  readonly lines: string[];
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
      this.starts.push(index + 1);
    }
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    this.lines = lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  }

  lineAt(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  codeStart(line: number): number {
    const text = this.lines[line];
    return this.starts[line] + text.length - text.trimStart().length;
  }
}
