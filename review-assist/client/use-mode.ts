import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { messageOf } from "../kit/shared/errors";
import { type DiffMode } from "../kit/shared/protocol";
import { modeRpc, setModeRpc } from "../shared/protocol";

export type SharedMode =
  | { readonly status: "loading" }
  | { readonly status: "unreadable" }
  /** `mode` null when no device has picked one for the workspace yet. */
  | { readonly status: "ready"; readonly mode: DiffMode | null };

/** The workspace's diff mode, shared by every device's review tab. */
export function useSharedMode(directory: string | null): [SharedMode, (mode: DiffMode) => void] {
  const queryClient = useQueryClient();
  const toast = useToast();
  const read = useRpc(modeRpc);
  const write = useRpc(setModeRpc);
  const key = ["review-mode", directory];
  const query = useQuery({
    queryKey: key,
    queryFn: () => read({ directory: directory ?? "" }),
    enabled: directory != null,
    retry: false,
  });
  const choose = useMutation({
    mutationFn: (mode: DiffMode) => write({ directory: directory ?? "", mode }),
    onMutate: async (mode) => {
      // Cancelling reverts an in-flight read to the data it started from, so set the pick again after.
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData(key, { mode });
    },
    onSuccess: (result) => queryClient.setQueryData(key, result),
    onError: (error) => {
      toast.error(`Could not share the diff mode: ${messageOf(error)}`);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const share = (mode: DiffMode): void => {
    queryClient.setQueryData(key, { mode });
    choose.mutate(mode);
  };
  const shared: SharedMode =
    query.data != null
      ? { status: "ready", mode: query.data.mode }
      : query.isError
        ? { status: "unreadable" }
        : { status: "loading" };
  return [shared, share];
}
