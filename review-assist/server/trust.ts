import { z } from "zod";
import type { Trust } from "../shared/protocol";
import { JsonSlots } from "./slots";

const bookSchema = z.record(z.string(), z.boolean());
type Book = z.infer<typeof bookSchema>;

const BOOK = "trust";

/** Decisions by Paseo project, covering all of a project's workspaces. */
export class ProjectTrust {
  private readonly slots: JsonSlots<Book>;

  constructor(directory: string) {
    this.slots = new JsonSlots(directory, bookSchema);
  }

  async read(projectId: string): Promise<Trust> {
    const book = await this.book();
    if (!Object.hasOwn(book, projectId)) return "undecided";
    return book[projectId] ? "trusted" : "restricted";
  }

  async allows(projectId: string): Promise<boolean> {
    return (await this.book())[projectId] === true;
  }

  async decide(projectId: string, trusted: boolean): Promise<Trust> {
    await this.slots.update(BOOK, (book) => ({ ...book, [projectId]: trusted }));
    return trusted ? "trusted" : "restricted";
  }

  private async book(): Promise<Book> {
    return (await this.slots.read(BOOK)) ?? {};
  }
}
