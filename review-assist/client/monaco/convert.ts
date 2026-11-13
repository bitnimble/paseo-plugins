import type { LspPosition, LspRange } from "../../shared/lsp";
import type { MonacoPosition, MonacoRange } from "./api";

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
