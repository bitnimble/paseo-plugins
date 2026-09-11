export interface LanguageEntry {
  readonly monacoLanguage: string;
  readonly lspLanguageId: string;
  readonly serverId: string;
}

const BY_EXTENSION: Readonly<Record<string, LanguageEntry>> = {
  ".ts": { monacoLanguage: "typescript", lspLanguageId: "typescript", serverId: "typescript" },
  ".mts": { monacoLanguage: "typescript", lspLanguageId: "typescript", serverId: "typescript" },
  ".cts": { monacoLanguage: "typescript", lspLanguageId: "typescript", serverId: "typescript" },
  ".tsx": { monacoLanguage: "typescript", lspLanguageId: "typescriptreact", serverId: "typescript" },
  ".js": { monacoLanguage: "javascript", lspLanguageId: "javascript", serverId: "typescript" },
  ".mjs": { monacoLanguage: "javascript", lspLanguageId: "javascript", serverId: "typescript" },
  ".cjs": { monacoLanguage: "javascript", lspLanguageId: "javascript", serverId: "typescript" },
  ".jsx": { monacoLanguage: "javascript", lspLanguageId: "javascriptreact", serverId: "typescript" },
  ".py": { monacoLanguage: "python", lspLanguageId: "python", serverId: "python" },
  ".pyi": { monacoLanguage: "python", lspLanguageId: "python", serverId: "python" },
  ".go": { monacoLanguage: "go", lspLanguageId: "go", serverId: "go" },
  ".rs": { monacoLanguage: "rust", lspLanguageId: "rust", serverId: "rust" },
  ".c": { monacoLanguage: "c", lspLanguageId: "c", serverId: "clang" },
  ".h": { monacoLanguage: "c", lspLanguageId: "c", serverId: "clang" },
  ".cc": { monacoLanguage: "cpp", lspLanguageId: "cpp", serverId: "clang" },
  ".cpp": { monacoLanguage: "cpp", lspLanguageId: "cpp", serverId: "clang" },
  ".hpp": { monacoLanguage: "cpp", lspLanguageId: "cpp", serverId: "clang" },
};

export function languageForPath(path: string): LanguageEntry | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  return BY_EXTENSION[name.slice(dot).toLowerCase()] ?? null;
}

export const LSP_MONACO_LANGUAGES: readonly string[] = [
  ...new Set(Object.values(BY_EXTENSION).map((entry) => entry.monacoLanguage)),
];
