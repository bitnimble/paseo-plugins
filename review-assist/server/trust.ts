import { join } from "node:path";
import { z } from "zod";
import type { Trust } from "../shared/protocol";
import { readJsonFile, writePrivateJson } from "./slots";

const bookSchema = z.record(z.string(), z.boolean());
type Book = z.infer<typeof bookSchema>;

/** Decisions by Paseo project, covering all of a project's workspaces. */
export class ProjectTrust {
  private book: Promise<Book> | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async read(projectId: string): Promise<Trust> {
    const book = await this.load();
    if (!Object.hasOwn(book, projectId)) return "undecided";
    return book[projectId] ? "trusted" : "restricted";
  }

  async allows(projectId: string): Promise<boolean> {
    return (await this.load())[projectId] === true;
  }

  decide(projectId: string, trusted: boolean): Promise<Trust> {
    const decided = this.writes.then(async () => {
      const book = { ...(await this.load()), [projectId]: trusted };
      await writePrivateJson(this.directory, this.file(), book);
      this.book = Promise.resolve(book);
      return trusted ? ("trusted" as const) : ("restricted" as const);
    });
    this.writes = decided.catch(() => undefined);
    return decided;
  }

  private load(): Promise<Book> {
    this.book ??= readJsonFile(this.file(), bookSchema).then(
      (book) => book ?? {},
      (error: unknown) => {
        this.book = null;
        throw error;
      },
    );
    return this.book;
  }

  private file(): string {
    return join(this.directory, "trust.json");
  }
}
