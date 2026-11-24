import { realpath } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { repoRoot } from "../kit/server/repo";

export async function locateDocument(path: string): Promise<{ root: string; path: string }> {
  const real = await realpath(path);
  const directory = dirname(real);
  const root = await repoRoot(directory).catch(() => directory);
  return { root, path: relative(root, real) };
}
