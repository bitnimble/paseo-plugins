import type { MonacoPosition, MonacoRange } from "./monaco-api";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface ResolvedLocation {
  uri: string;
  range: LspRange;
}

export interface ResolvedCompletion {
  label: string;
  kind: number;
  insertText: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
}

/** LSP `CompletionItemKind` (1-based) to the Monaco enum, which orders its members differently. */
const COMPLETION_KINDS: readonly number[] = [
  18, 18, 0, 1, 2, 3, 4, 5, 7, 8, 9, 12, 13, 15, 17, 27, 19, 20, 21, 23, 16, 14, 6, 10, 11, 24,
];

export function toLspPosition(position: MonacoPosition): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function toMonacoRange(range: LspRange): MonacoRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

export function toLocations(result: unknown): ResolvedLocation[] {
  const candidates = Array.isArray(result) ? result : [result];
  const locations: ResolvedLocation[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const uri = candidate["uri"] ?? candidate["targetUri"];
    const range =
      candidate["targetSelectionRange"] ?? candidate["targetRange"] ?? candidate["range"];
    if (typeof uri === "string" && isRange(range)) {
      locations.push({ uri, range });
    }
  }
  return locations;
}

export function toHoverMarkdown(result: unknown): { markdown: string; range?: LspRange } | null {
  if (!isRecord(result)) {
    return null;
  }
  const markdown = markdownFrom(result["contents"]);
  if (markdown.length === 0) {
    return null;
  }
  const range = result["range"];
  return isRange(range) ? { markdown, range } : { markdown };
}

export function toCompletions(result: unknown): ResolvedCompletion[] {
  const items = Array.isArray(result) ? result : isRecord(result) ? result["items"] : null;
  if (!Array.isArray(items)) {
    return [];
  }
  const completions: ResolvedCompletion[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item["label"] !== "string") {
      continue;
    }
    const label = item["label"];
    const insertText = typeof item["insertText"] === "string" ? item["insertText"] : label;
    const lspKind = typeof item["kind"] === "number" ? item["kind"] : 1;
    const detail = typeof item["detail"] === "string" ? item["detail"] : undefined;
    const documentation = markdownFrom(item["documentation"]);
    const sortText = typeof item["sortText"] === "string" ? item["sortText"] : undefined;
    completions.push({
      label,
      insertText,
      kind: COMPLETION_KINDS[lspKind] ?? 18,
      detail,
      documentation: documentation.length > 0 ? documentation : undefined,
      sortText,
    });
  }
  return completions;
}

function markdownFrom(contents: unknown): string {
  if (typeof contents === "string") {
    return contents;
  }
  if (Array.isArray(contents)) {
    return contents.map(markdownFrom).filter((part) => part.length > 0).join("\n\n");
  }
  if (!isRecord(contents)) {
    return "";
  }
  if (typeof contents["value"] !== "string") {
    return "";
  }
  const value = contents["value"];
  const language = contents["language"];
  return typeof language === "string" ? `\`\`\`${language}\n${value}\n\`\`\`` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function isRange(value: unknown): value is LspRange {
  if (!isRecord(value)) {
    return false;
  }
  return isPosition(value["start"]) && isPosition(value["end"]);
}

function isPosition(value: unknown): value is LspPosition {
  return isRecord(value) && typeof value["line"] === "number" && typeof value["character"] === "number";
}
