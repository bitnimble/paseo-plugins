import { useMemo, useRef, useState } from "react";
import type { CommentTarget } from "../shared/comments";
import type { DraftComment } from "../shared/protocol";
import type { SideLine } from "../shared/sides";
import type { CommentDraft, FileComments, Suggestion } from "./comments";

export interface CommentStore {
  readonly comments: readonly DraftComment[];
  save(comment: DraftComment): void;
  remove(id: string): void;
}

export interface CommentActions {
  compose(filePath: string, blockKey: string, lines: readonly SideLine[], start: number, end: number, extend: boolean): void;
  edit(comment: DraftComment): void;
  cancel(): void;
  submit(target: CommentTarget, body: string, suggestion: Suggestion | null): void;
  remove(id: string): void;
}

/** The one comment open for writing at a time, saved to `store` when submitted. */
export function useCommentDrafts(store: CommentStore): { draft: CommentDraft | null; actions: CommentActions } {
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const latest = useRef({ store, draft });
  latest.current = { store, draft };
  const actions = useMemo(
    (): CommentActions => ({
      compose: (filePath, blockKey, lines, start, end, extend) =>
        setDraft((current): CommentDraft => {
          const same = current?.kind === "new" && current.blockKey === blockKey ? current : null;
          const from = same == null ? -1 : lines.indexOf(same.lines[same.start]);
          const to = same == null ? -1 : lines.indexOf(same.lines[same.end]);
          if (!extend || from < 0 || to < 0) return { kind: "new", filePath, blockKey, lines, start, end };
          return { kind: "new", filePath, blockKey, lines, start: Math.min(from, start), end: Math.max(to, end) };
        }),
      edit: (comment) => setDraft({ kind: "edit", comment }),
      cancel: () => setDraft(null),
      submit: (target, body, suggestion) => {
        const { draft: current, store: currentStore } = latest.current;
        currentStore.save(
          current?.kind === "edit"
            ? { ...current.comment, body, suggestion }
            : { ...target, id: newCommentId(), body, suggestion, createdAt: new Date().toISOString() },
        );
        setDraft(null);
      },
      remove: (id) => {
        latest.current.store.remove(id);
        setDraft((current) => (current?.kind === "edit" && current.comment.id === id ? null : current));
      },
    }),
    [],
  );
  return { draft, actions };
}

/** One file's comments, for the view of it opened as `blockKey`; `draft` is the open comment if it is on this view. */
export function fileComments(
  path: string,
  blockKey: string,
  comments: readonly DraftComment[],
  draft: CommentDraft | null,
  actions: CommentActions,
): FileComments {
  return {
    comments,
    draft,
    compose: (lines, start, end, extend = false) => actions.compose(path, blockKey, lines, start, end, extend),
    edit: actions.edit,
    cancel: actions.cancel,
    submit: actions.submit,
    remove: actions.remove,
  };
}

function newCommentId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
