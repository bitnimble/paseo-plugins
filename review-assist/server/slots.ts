import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ZodType } from "zod";
import { type DiffMode, modeKey } from "../shared/protocol";

export interface Target {
  readonly directory: string;
  readonly mode: DiffMode;
}

export function cacheDirectory(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "paseo-review-assist");
}

/** A JSON file per directory and diff mode, cached in memory, with each slot's updates applied in order. */
export class JsonSlots<Value> {
  private readonly values = new Map<string, Promise<Value | null>>();
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(
    private readonly directory: string,
    private readonly suffix: string,
    private readonly schema: ZodType<Value>,
  ) {}

  read(target: Target): Promise<Value | null> {
    const key = slotKey(target);
    let value = this.values.get(key);
    if (value == null) {
      const loading = this.load(key);
      this.values.set(key, loading);
      loading.catch(() => {
        if (this.values.get(key) === loading) this.values.delete(key);
      });
      value = loading;
    }
    return value;
  }

  update(target: Target, change: (current: Value | null) => Value): Promise<Value> {
    const key = slotKey(target);
    const result = (this.writes.get(key) ?? Promise.resolve()).then(async () => {
      const next = change(await this.read(target));
      await this.save(key, next);
      return next;
    });
    this.writes.set(key, result.catch(() => undefined));
    return result;
  }

  private load(key: string): Promise<Value | null> {
    return readJsonFile(this.fileFor(key), this.schema);
  }

  private async save(key: string, value: Value): Promise<void> {
    await writePrivateJson(this.directory, this.fileFor(key), value);
    this.values.set(key, Promise.resolve(value));
  }

  private fileFor(key: string): string {
    return join(this.directory, `${key}${this.suffix}.json`);
  }
}

/** Null when the file is missing or does not match `schema`; other read errors reject. */
export async function readJsonFile<Value>(file: string, schema: ZodType<Value>): Promise<Value | null> {
  // Only a missing file is empty: treating EACCES or EMFILE as empty lets the next write wipe it.
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const parsed = schema.safeParse(text == null ? null : parseJson(text));
  return parsed.success ? parsed.data : null;
}

export async function writePrivateJson(directory: string, file: string, value: unknown): Promise<void> {
  // Holds diffs and comments on them, untracked files included, so keep them private.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = `${file}.${randomUUID()}.tmp`;
  await writeFile(staging, JSON.stringify(value), { mode: 0o600 });
  await rename(staging, file);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function targetKey({ directory, mode }: Target): string {
  return `${directory}\0${modeKey(mode)}`;
}

function slotKey(target: Target): string {
  return createHash("sha256").update(targetKey(target)).digest("hex").slice(0, 32);
}
