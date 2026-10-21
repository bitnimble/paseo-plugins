import { join } from "node:path";
import { z } from "zod";
import type { Trust } from "../shared/protocol";
import { readJsonFile, writePrivateJson } from "./slots";

const bookSchema = z.record(z.string(), z.object({ trusted: z.boolean(), root: z.string() }));
type Book = z.infer<typeof bookSchema>;

export class WorkspaceTrust {
  private book: Promise<Book> | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async read(workspace: string): Promise<Trust> {
    return trustOf((await this.load())[workspace]);
  }

  /** Whether a trusted workspace has its files in `root`. */
  async allows(root: string): Promise<boolean> {
    return Object.values(await this.load()).some((entry) => entry.trusted && entry.root === root);
  }

  decide(workspace: string, root: string, trusted: boolean): Promise<Trust> {
    const decided = this.writes.then(async () => {
      const book = { ...(await this.load()), [workspace]: { trusted, root } };
      await writePrivateJson(this.directory, this.file(), book);
      this.book = Promise.resolve(book);
      return trustOf(book[workspace]);
    });
    this.writes = decided.catch(() => undefined);
    return decided;
  }

  private load(): Promise<Book> {
    this.book ??= readJsonFile(this.file(), bookSchema).then((book) => book ?? {});
    return this.book;
  }

  private file(): string {
    return join(this.directory, "trust.json");
  }
}

function trustOf(entry: Book[string] | undefined): Trust {
  if (entry == null) return "undecided";
  return entry.trusted ? "trusted" : "restricted";
}
