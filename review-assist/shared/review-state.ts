import { withComment } from "./comments";
import type { ReviewState, StateChange, ViewedMark } from "./protocol";

const MAX_VIEWED_MARKS = 2_000;

export const EMPTY_REVIEW_STATE: ReviewState = { viewed: [], comments: [] };

export function viewedMarkKey({ path, fingerprint }: ViewedMark): string {
  return `${path}\0${fingerprint}`;
}

export function applyStateChange(state: ReviewState, change: StateChange): ReviewState {
  if (change.kind === "viewed") {
    const changed = new Map(change.marks.map((mark) => [viewedMarkKey(mark), mark]));
    const others = state.viewed.filter((mark) => !changed.has(viewedMarkKey(mark)));
    return { ...state, viewed: change.viewed ? [...others, ...changed.values()].slice(-MAX_VIEWED_MARKS) : others };
  }
  const kept = state.comments.filter(({ id }) => !change.remove.includes(id));
  return { ...state, comments: change.save.reduce(withComment, kept) };
}
