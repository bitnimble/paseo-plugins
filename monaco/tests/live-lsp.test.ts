import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { toLocations } from "../client/convert.ts";
import { LspSession } from "../server/lsp.ts";
import { SERVER_COMMANDS } from "../server/servers.ts";

const command = SERVER_COMMANDS["typescript"] ?? [];
const installed = (() => {
  try {
    execFileSync("which", [command[0] ?? ""], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test(
  "a real language server answers definition and references across files",
  { skip: installed ? false : `${command[0] ?? "the server"} is not installed` },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "monaco-lsp-"));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
    await writeFile(join(directory, "lib.ts"), "export function greet(name: string) {\n  return name;\n}\n");
    await writeFile(join(directory, "app.ts"), 'import { greet } from "./lib";\n\ngreet("world");\n');

    const session = await LspSession.start(command, directory);
    try {
      const appUri = pathToFileURL(join(directory, "app.ts")).href;
      const libUri = pathToFileURL(join(directory, "lib.ts")).href;
      session.openDocument(appUri, "typescript", 'import { greet } from "./lib";\n\ngreet("world");\n');

      const definition = await session.request("textDocument/definition", {
        textDocument: { uri: appUri },
        position: { line: 2, character: 1 },
      });
      assert.deepEqual(
        toLocations(definition).map((location) => location.uri),
        [libUri],
      );

      const references = await session.request("textDocument/references", {
        textDocument: { uri: appUri },
        position: { line: 2, character: 1 },
        context: { includeDeclaration: true },
      });
      assert.ok(toLocations(references).length >= 2);
    } finally {
      await session.dispose();
    }
  },
);
