export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

/** `Location`, `Location[]` or `LocationLink[]`, as servers answer definition and references. */
export function toLocations(result: unknown): { uri: string; range: LspRange }[] {
  const candidates = Array.isArray(result) ? result : [result];
  const locations: { uri: string; range: LspRange }[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const uri = candidate["uri"] ?? candidate["targetUri"];
    const range = candidate["targetSelectionRange"] ?? candidate["targetRange"] ?? candidate["range"];
    if (typeof uri === "string" && isRange(range)) locations.push({ uri, range });
  }
  return locations;
}

export function toHoverMarkdown(result: unknown): { markdown: string; range?: LspRange } | null {
  if (!isRecord(result)) return null;
  const markdown = markdownFrom(result["contents"]);
  if (markdown.length === 0) return null;
  const range = result["range"];
  return isRange(range) ? { markdown, range } : { markdown };
}

function markdownFrom(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map(markdownFrom).filter((part) => part.length > 0).join("\n\n");
  }
  if (!isRecord(contents) || typeof contents["value"] !== "string") return "";
  const value = contents["value"];
  const language = contents["language"];
  return typeof language === "string" ? `\`\`\`${language}\n${value}\n\`\`\`` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function isRange(value: unknown): value is LspRange {
  return isRecord(value) && isPosition(value["start"]) && isPosition(value["end"]);
}

function isPosition(value: unknown): value is LspPosition {
  return isRecord(value) && typeof value["line"] === "number" && typeof value["character"] === "number";
}
