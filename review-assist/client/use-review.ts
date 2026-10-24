import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { withComment } from "../shared/comments";
import { type FileFacts, type ParsedDiff, parseDiff } from "../shared/diff";
import { messageOf } from "../shared/errors";
import {
  type DiffBase,
  type DiffMode,
  type DraftComment,
  type Reviewer,
  type GuideJob,
  type GuideRecord,
  type ReviewState,
  type Trust,
  type ViewedMark,
  commentRpc,
  diffRpc,
  generateRpc,
  guideRpc,
  modeKey,
  setTrustRpc,
  stateRpc,
  submitRpc,
  trustRpc,
  viewedRpc,
} from "../shared/protocol";
import type { CommentStore } from "./diff-list";
import type { CodeSource } from "./monaco/review-monaco";

const JOB_POLL_MS = 2_000;
const STATE_WRITE = ["review-state-write"];
const EMPTY_STATE: ReviewState = { viewed: [], comments: [] };

export type LiveDiff =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: string }
  | {
      readonly status: "ready";
      readonly hash: string;
      readonly base: DiffBase;
      readonly diff: ParsedDiff;
      readonly source: CodeSource;
    };

export interface GuideState {
  readonly job: GuideJob | null;
  readonly record: GuideRecord | null;
  /** The diff the guide was generated from, which may be older than the live diff. */
  readonly diff: ParsedDiff | null;
}

type StateChange =
  | { readonly kind: "viewed"; readonly mark: ViewedMark; readonly viewed: boolean }
  | { readonly kind: "save"; readonly comment: DraftComment }
  | { readonly kind: "delete"; readonly id: string };

export interface Review {
  readonly live: LiveDiff;
  readonly guide: GuideState | null;
  /** Why the guide could not be read, while there is none to show. */
  readonly guideError: string | null;
  readonly state: ReviewState;
  /** Null until the daemon answers. */
  readonly trust: Trust | null;
  readonly refreshing: boolean;
  refresh(): void;
  generate(): void;
  setViewed(mark: ViewedMark, viewed: boolean): void;
  saveComment(comment: DraftComment): void;
  deleteComment(id: string): void;
  setTrust(trusted: boolean): void;
  /**
   * Resolves to an error message, or null once the agent has the comments. `reviewer` may be null
   * when every comment is a suggested edit.
   */
  submit(input: { reviewer: Reviewer | null; message: string }): Promise<string | null>;
}

export function commentStore(review: Review): CommentStore {
  return { comments: review.state.comments, save: review.saveComment, remove: review.deleteComment };
}

/**
 * `revision` changes whenever the workspace's diff stat does, refetching the diff without polling.
 */
export function useReview(input: {
  workspaceId: string;
  directory: string | null;
  mode: DiffMode;
  revision: string;
}): Review {
  const { workspaceId, directory, mode, revision } = input;
  const queryClient = useQueryClient();
  const toast = useToast();
  const readDiff = useRpc(diffRpc);
  const readGuide = useRpc(guideRpc);
  const startGeneration = useRpc(generateRpc);
  const readState = useRpc(stateRpc);
  const writeViewed = useRpc(viewedRpc);
  const writeComment = useRpc(commentRpc);
  const sendComments = useRpc(submitRpc);
  const readTrust = useRpc(trustRpc);
  const writeTrust = useRpc(setTrustRpc);
  const target = { directory: directory ?? "", mode };
  const key = modeKey(mode);
  const guideKey = ["review-guide", directory, key];
  const stateKey = ["review-state", directory, key];
  const trustKey = ["review-trust", directory];

  const diffQuery = useQuery({
    queryKey: ["review-diff", directory, key, revision],
    queryFn: () => readDiff(target),
    enabled: directory != null,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === key ? previous : undefined),
  });
  const guideQuery = useQuery({
    queryKey: guideKey,
    queryFn: () => readGuide(target),
    enabled: directory != null,
    refetchInterval: (query) => (query.state.data?.job?.status === "running" ? JOB_POLL_MS : false),
  });
  const stateQuery = useQuery({ queryKey: stateKey, queryFn: () => readState(target), enabled: directory != null });
  const trustQuery = useQuery({
    queryKey: trustKey,
    queryFn: () => readTrust({ directory: target.directory }),
    enabled: directory != null,
  });
  const trustWrite = useMutation({
    mutationFn: (trusted: boolean) => writeTrust({ directory: target.directory, trusted }),
    onSuccess: (result) => queryClient.setQueryData(trustKey, result),
  });

  const generation = useMutation({
    mutationFn: () => startGeneration({ ...target, workspaceId }),
    onSuccess: ({ job }) => {
      queryClient.setQueryData(guideKey, (old: typeof guideQuery.data) => ({ guide: old?.guide ?? null, job }));
    },
    onError: (error) => toast.error(`Could not start the guided review: ${messageOf(error)}`),
  });
  const stateWrite = useMutation({
    mutationKey: STATE_WRITE,
    mutationFn: (change: StateChange) => {
      if (change.kind === "viewed") return writeViewed({ ...target, ...change.mark, viewed: change.viewed });
      return writeComment({
        ...target,
        change: change.kind === "save" ? { action: "save", comment: change.comment } : { action: "delete", id: change.id },
      });
    },
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: stateKey });
      queryClient.setQueryData(stateKey, (old: ReviewState | undefined) => applyChange(old ?? EMPTY_STATE, change));
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

  const response = diffQuery.data;
  const diffError = diffQuery.error;
  const live = useMemo((): LiveDiff => {
    if (response == null) return diffError == null ? { status: "loading" } : { status: "failed", error: messageOf(diffError) };
    if (response.status === "failed") return response;
    const parsed = safeParse(response.raw, response.facts);
    return "error" in parsed
      ? { status: "failed", error: parsed.error }
      : {
          status: "ready",
          hash: response.hash,
          base: response.base,
          diff: parsed.diff,
          source: { root: response.root, tree: response.tree, base: response.base.sha },
        };
  }, [response, diffError]);

  const guideData = guideQuery.data;
  const recordRaw = guideData?.guide?.raw ?? null;
  const recordFacts = guideData?.guide?.facts;
  const liveMatch = live.status === "ready" && live.hash === guideData?.guide?.diffHash ? live.diff : null;
  // Keyed on the diff alone: a new parse means new blocks to lay out.
  const recordDiff = useMemo((): ParsedDiff | null => {
    if (liveMatch != null || recordRaw == null) return liveMatch;
    const parsed = safeParse(recordRaw, recordFacts);
    return "error" in parsed ? null : parsed.diff;
  }, [recordRaw, recordFacts, liveMatch]);
  const guide = useMemo(
    (): GuideState | null =>
      guideData == null ? null : { job: guideData.job, record: guideData.guide, diff: recordDiff },
    [guideData, recordDiff],
  );

  return {
    live,
    guide,
    guideError: guideData == null && guideQuery.error != null ? messageOf(guideQuery.error) : null,
    state: stateQuery.data ?? EMPTY_STATE,
    trust: trustQuery.data?.trust ?? null,
    refreshing: diffQuery.isFetching,
    refresh: () => {
      void diffQuery.refetch();
      void guideQuery.refetch();
    },
    generate: () => generation.mutate(),
    setViewed: (mark, viewed) => stateWrite.mutate({ kind: "viewed", mark, viewed }),
    saveComment: (comment) => stateWrite.mutate({ kind: "save", comment }),
    deleteComment: (id) => stateWrite.mutate({ kind: "delete", id }),
    setTrust: (trusted) => trustWrite.mutate(trusted),
    submit: async ({ reviewer, message }) => {
      if (live.status !== "ready") return "The diff is still loading.";
      const commentIds = (stateQuery.data ?? EMPTY_STATE).comments.map(({ id }) => id);
      try {
        const result = await sendComments({ ...target, baseRef: live.base.sha, reviewer, message, commentIds });
        if (result.status === "failed") return result.error;
        queryClient.setQueryData(stateKey, result.state);
        return null;
      } catch (error) {
        return messageOf(error);
      } finally {
        // Suggested edits may have changed the working tree and comments, even when the send failed.
        void queryClient.invalidateQueries({ queryKey: ["review-diff", directory] });
        void queryClient.invalidateQueries({ queryKey: stateKey });
      }
    },
  };
}

function applyChange(state: ReviewState, change: StateChange): ReviewState {
  if (change.kind === "viewed") {
    const { path, fingerprint } = change.mark;
    const others = state.viewed.filter((mark) => mark.path !== path || mark.fingerprint !== fingerprint);
    return { ...state, viewed: change.viewed ? [...others, change.mark] : others };
  }
  if (change.kind === "delete") {
    return { ...state, comments: state.comments.filter(({ id }) => id !== change.id) };
  }
  return { ...state, comments: withComment(state.comments, change.comment) };
}

function safeParse(raw: string, facts?: FileFacts): { diff: ParsedDiff } | { error: string } {
  try {
    return { diff: parseDiff(raw, facts) };
  } catch (error) {
    return { error: messageOf(error) };
  }
}
