import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { messageOf } from "../shared/errors";
import {
  type DiffMode,
  type DraftComment,
  type ReviewState,
  type Reviewer,
  type StateChange,
  type ViewedMark,
  modeKey,
  stateChangeRpc,
  stateRpc,
  submitRpc,
} from "../shared/protocol";
import { EMPTY_REVIEW_STATE, applyStateChange } from "../shared/review-state";
import { usePackedRpc } from "./packed";

const STATE_WRITE = ["review-state-write"];

/** Resolves to an error message, or null once the agent has the comments. `reviewer` may be null when every comment is a suggested edit. */
export type SubmitComments = (input: { reviewer: Reviewer | null; message: string }) => Promise<string | null>;

export interface ReviewStateStore {
  readonly state: ReviewState;
  /** False until the saved state has loaded. */
  readonly loaded: boolean;
  setViewed(marks: readonly ViewedMark[], viewed: boolean): void;
  saveComment(comment: DraftComment): void;
  deleteComment(id: string): void;
  /** Sends the comments in `commentIds`, making their suggested edits first. */
  submit(input: {
    baseRef: string;
    reviewer: Reviewer | null;
    message: string;
    commentIds: readonly string[];
  }): Promise<string | null>;
}

/** The comments and viewed marks saved for `directory`'s changes in `mode`; null `directory` waits. */
export function useReviewState(
  directory: string | null,
  mode: DiffMode,
  /** Called once a submit settles: suggested edits may have changed the files, even when sending failed. */
  onSubmitted: () => void,
): ReviewStateStore {
  const queryClient = useQueryClient();
  const toast = useToast();
  const readState = usePackedRpc(stateRpc);
  const writeState = usePackedRpc(stateChangeRpc);
  const sendComments = useRpc(submitRpc);
  const target = { directory: directory ?? "", mode };
  const stateKey = ["review-state", directory, modeKey(mode)];

  const stateQuery = useQuery({ queryKey: stateKey, queryFn: () => readState(target), enabled: directory != null });
  const stateWrite = useMutation({
    mutationKey: STATE_WRITE,
    mutationFn: (change: StateChange) => writeState({ ...target, change }),
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: stateKey });
      queryClient.setQueryData(stateKey, (old: ReviewState | undefined) =>
        applyStateChange(old ?? EMPTY_REVIEW_STATE, change),
      );
    },
    onError: (error, change) =>
      toast.error(`Could not save the ${change.kind === "viewed" ? "viewed mark" : "comment"}: ${messageOf(error)}`),
    onSettled: async () => {
      // An earlier write's refetch would land before a later one is saved and flicker it back.
      if (queryClient.isMutating({ mutationKey: STATE_WRITE }) === 1) {
        await queryClient.invalidateQueries({ queryKey: stateKey });
      }
    },
  });

  return {
    state: stateQuery.data ?? EMPTY_REVIEW_STATE,
    loaded: stateQuery.isSuccess,
    setViewed: (marks, viewed) => stateWrite.mutate({ kind: "viewed", marks, viewed }),
    saveComment: (comment) => stateWrite.mutate({ kind: "comments", remove: [], save: [comment] }),
    deleteComment: (id) => stateWrite.mutate({ kind: "comments", remove: [id], save: [] }),
    submit: async ({ baseRef, reviewer, message, commentIds }) => {
      if (commentIds.length === 0) return "There are no comments to send.";
      try {
        const result = await sendComments({ ...target, baseRef, reviewer, message, commentIds: [...commentIds] });
        if (result.status === "failed") return result.error;
        queryClient.setQueryData(stateKey, result.state);
        return null;
      } catch (error) {
        return messageOf(error);
      } finally {
        onSubmitted();
        void queryClient.invalidateQueries({ queryKey: stateKey });
      }
    },
  };
}
