import { withComment } from "../shared/comments";
import { type DraftComment, type ReviewState, type ViewedMark, reviewStateSchema } from "../shared/protocol";
import { JsonSlots, type Target } from "./slots";

const MAX_VIEWED_MARKS = 2_000;
const EMPTY: ReviewState = { viewed: [], comments: [] };

export class ReviewStates {
  private readonly slots: JsonSlots<ReviewState>;

  constructor(directory: string) {
    this.slots = new JsonSlots(directory, ".state", reviewStateSchema);
  }

  async read(target: Target): Promise<ReviewState> {
    return (await this.slots.read(target)) ?? EMPTY;
  }

  setViewed(target: Target, mark: ViewedMark, viewed: boolean): Promise<ReviewState> {
    return this.slots.update(target, (current) => {
      const state = current ?? EMPTY;
      const others = state.viewed.filter(
        ({ path, fingerprint }) => path !== mark.path || fingerprint !== mark.fingerprint,
      );
      return { ...state, viewed: viewed ? [...others, mark].slice(-MAX_VIEWED_MARKS) : others };
    });
  }

  saveComment(target: Target, comment: DraftComment): Promise<ReviewState> {
    return this.slots.update(target, (current) => {
      const state = current ?? EMPTY;
      return { ...state, comments: withComment(state.comments, comment) };
    });
  }

  deleteComments(target: Target, ids: readonly string[]): Promise<ReviewState> {
    return this.slots.update(target, (current) => {
      const state = current ?? EMPTY;
      return { ...state, comments: state.comments.filter(({ id }) => !ids.includes(id)) };
    });
  }
}
