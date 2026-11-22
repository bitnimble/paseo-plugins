import { z } from "zod";
import { type DiffMode, diffModeSchema } from "../shared/protocol";
import { JsonSlots } from "./slots";

const bookSchema = z.record(z.string(), diffModeSchema);
type Book = z.infer<typeof bookSchema>;

const BOOK = "modes";

/** The diff mode last picked for each workspace directory, on any device. */
export class ReviewModes {
  private readonly slots: JsonSlots<Book>;

  constructor(directory: string) {
    this.slots = new JsonSlots(directory, bookSchema);
  }

  async read(directory: string): Promise<DiffMode | null> {
    return (await this.slots.read(BOOK))?.[directory] ?? null;
  }

  async choose(directory: string, mode: DiffMode): Promise<DiffMode> {
    await this.slots.update(BOOK, (book) => ({ ...book, [directory]: mode }));
    return mode;
  }
}
