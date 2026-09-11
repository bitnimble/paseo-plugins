export const SERVER_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  typescript: ["typescript-language-server", "--stdio"],
  python: ["pyright-langserver", "--stdio"],
  go: ["gopls"],
  rust: ["rust-analyzer"],
  clang: ["clangd"],
};
