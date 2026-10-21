import { existsSync } from "node:fs";
import { extname, join } from "node:path";

interface ServerSpec {
  readonly id: string;
  readonly command: readonly string[];
  /** File extension to LSP language id. */
  readonly languages: Readonly<Record<string, string>>;
}

const SERVERS: readonly ServerSpec[] = [
  {
    id: "typescript",
    command: ["typescript-language-server", "--stdio"],
    languages: {
      ".ts": "typescript",
      ".mts": "typescript",
      ".cts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".jsx": "javascriptreact",
    },
  },
  { id: "python", command: ["pyright-langserver", "--stdio"], languages: { ".py": "python", ".pyi": "python" } },
  { id: "go", command: ["gopls"], languages: { ".go": "go" } },
  { id: "rust", command: ["rust-analyzer"], languages: { ".rs": "rust" } },
  {
    id: "clang",
    command: ["clangd"],
    languages: { ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp" },
  },
];

export interface ServerChoice {
  readonly id: string;
  readonly languageId: string;
  readonly command: readonly string[];
}

export function serverFor(root: string, path: string): ServerChoice | null {
  const extension = extname(path).toLowerCase();
  const spec = SERVERS.find((server) => extension in server.languages);
  if (spec == null) {
    return null;
  }
  const [binary, ...args] = spec.command;
  // The repository's own copy matches its toolchain.
  const local = join(root, "node_modules", ".bin", binary);
  return { id: spec.id, languageId: spec.languages[extension], command: [existsSync(local) ? local : binary, ...args] };
}
