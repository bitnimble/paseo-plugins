import { withComment } from "./comments";
import type { ReviewState, StateChange } from "./protocol";

const MAX_VIEWED_MARKS = 2_000;

export const EMPTY_REVIEW_STATE: ReviewState = { viewed: [], comments: [] };

export function applyStateChange(state: ReviewState, change: StateChange): ReviewState {
  if (change.kind === "viewed") {
    const { mark } = change;
    const others = state.viewed.filter(
      ({ path, fingerprint }) => path !== mark.path || fingerprint !== mark.fingerprint,
    );
    return { ...state, viewed: change.viewed ? [...others, mark].slice(-MAX_VIEWED_MARKS) : others };
  }
  const kept = state.comments.filter(({ id }) => !change.remove.includes(id));
  return { ...state, comments: change.save.reduce(withComment, kept) };
}
