import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "target", "vendor", "__pycache__"]);

export function isInside(directory: string, absolute: string): boolean {
  const root = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return absolute === directory || absolute.startsWith(root);
}

export function resolveInside(directory: string, path: string): string {
  const absolute = resolve(directory, path);
  if (!isInside(directory, absolute)) {
    throw new Error(`Path escapes the workspace directory: ${path}`);
  }
  return absolute;
}

export async function readFileAt(absolute: string): Promise<string> {
  const { size } = await stat(absolute);
  if (size > MAX_FILE_BYTES) {
    throw new Error(`${absolute} is larger than ${String(MAX_FILE_BYTES)} bytes`);
  }
  return await readFile(absolute, "utf8");
}

export async function writeFileAt(absolute: string, text: string): Promise<void> {
  await writeFile(absolute, text, "utf8");
}

export async function listWorkspaceFiles(
  directory: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const tracked = await listTrackedFiles(directory);
  const files = tracked ?? (await walk(directory, directory, []));
  files.sort();
  return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}

async function listTrackedFiles(directory: string): Promise<string[] | null> {
  try {
    const { stdout } = await run(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: directory, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split("\0").filter((path) => path.length > 0);
  } catch {
    return null;
  }
}

async function walk(root: string, directory: string, collected: string[]): Promise<string[]> {
  if (collected.length > MAX_FILES) {
    return collected;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.isDirectory()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await walk(root, join(directory, entry.name), collected);
      }
      continue;
    }
    if (entry.isFile()) {
      collected.push(relative(root, join(directory, entry.name)));
    }
  }
  return collected;
}
