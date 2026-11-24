import { useRpc } from "@getpaseo/plugin/client";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { FileText } from "../kit/client/file-text";
import { usePackedRpc } from "../kit/client/packed";
import type { DiffFile } from "../kit/shared/diff";
import { messageOf } from "../kit/shared/errors";
import { hashText } from "../kit/shared/hash";
import {
  type DifftasticStatus,
  type SyntaxDiff,
  difftasticStatusRpc,
  fileRpc,
  highlightRpc,
  leaseRpc,
  lspRpc,
  monacoRpc,
  syntaxDiffRpc,
} from "../shared/protocol";
import { type CodeSource, reviewMonaco } from "./monaco/review-monaco";
import type { FileSyntax } from "./syntax";
import { isMonacoSupported } from "./web";

const LEASE_REFRESH_MS = 30_000;

/** The file as the whole diff leaves it. */
export function useFileText(source: CodeSource, file: DiffFile, enabled: boolean): FileText {
  const read = usePackedRpc(fileRpc);
  const query = useQuery({
    // By content where the diff names it, so a refresh that leaves the file alone reads nothing.
    queryKey: ["review-file", source.root, file.newBlob ?? source.tree, file.newPath],
    queryFn: () => read({ root: source.root, tree: source.tree, path: file.newPath ?? "" }),
    enabled: enabled && file.newPath != null,
    staleTime: Infinity,
    // The file's previous text until the new one arrives, so its editor swaps models instead of remounting.
    // Only the same file's: a list row can be handed another file.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[3] === file.newPath ? previous : undefined),
  });
  if (file.newPath == null) return { status: "ready", text: "", previous: false };
  if (query.data?.status === "ready") return { ...query.data, previous: query.isPlaceholderData };
  if (query.data != null) return query.data;
  return query.error == null ? { status: "loading" } : { status: "failed", error: messageOf(query.error) };
}

export function useSyntax(source: CodeSource, file: DiffFile, enabled: boolean): FileSyntax | null {
  const highlight = usePackedRpc(highlightRpc);
  const query = useQuery({
    queryKey: ["review-syntax", source.root, file.newBlob ?? source.tree, source.base, file.oldPath, file.newPath],
    queryFn: () =>
      highlight({ root: source.root, tree: source.tree, base: source.base, path: file.newPath, oldPath: file.oldPath }),
    enabled,
    staleTime: Infinity,
  });
  return query.data?.status === "ready" ? query.data : null;
}

export const DIFFTASTIC_KEY = ["review-difftastic"];
export const SYNTAX_DIFF_KEY = ["review-syntax-diff"];

export function useDifftasticStatus(): UseQueryResult<DifftasticStatus> {
  const read = useRpc(difftasticStatusRpc);
  return useQuery({ queryKey: DIFFTASTIC_KEY, queryFn: () => read({ recheck: false }), staleTime: Infinity });
}

/** Undefined until difftastic answers; null when it is off or can't diff the sides. */
export function useSyntaxDiff(path: string, original: string, modified: string, enabled: boolean): SyntaxDiff | null | undefined {
  const diff = usePackedRpc(syntaxDiffRpc);
  const key = useMemo(() => [hashText(original), hashText(modified)], [original, modified]);
  const query = useQuery({
    queryKey: [...SYNTAX_DIFF_KEY, path, ...key],
    queryFn: () => diff({ path, original, modified }),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  if (!enabled) return null;
  if (query.data?.status === "ready") return query.data.diff;
  return query.isPending ? undefined : null;
}

/** Connects Monaco to the daemon and starts loading it; `features` adds language features for its root's files. */
export function useCodeIntelligence(features: { projectId: string; root: string } | null): void {
  const read = usePackedRpc(fileRpc);
  const lsp = usePackedRpc(lspRpc);
  const lease = useRpc(leaseRpc);
  const monaco = usePackedRpc(monacoRpc);

  useEffect(() => {
    reviewMonaco.connect({
      asset: async (asset) => {
        const first = await monaco({ asset, offset: 0 });
        const offsets: number[] = [];
        for (let offset = first.text.length; first.text.length > 0 && offset < first.total; offset += first.text.length) {
          offsets.push(offset);
        }
        const rest = await Promise.all(offsets.map((offset) => monaco({ asset, offset })));
        return [first, ...rest].map((part) => part.text).join("");
      },
      file: async (input) => {
        const response = await read(input);
        if (response.status === "failed") throw new Error(response.error);
        return response.text;
      },
      lsp: async (input) => {
        const response = await lsp(input);
        if (response.status === "failed") throw new Error(response.error);
        return response.status === "ok" ? response.result : null;
      },
    });
    if (isMonacoSupported()) reviewMonaco.load().catch(() => undefined);
  }, [read, lsp, monaco]);

  const projectId = features?.projectId ?? null;
  const root = features?.root ?? null;
  useEffect(() => {
    if (projectId == null || root == null) return;
    const disable = reviewMonaco.enableLanguageFeatures(projectId, root);
    const leaseId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const hold = () => void lease({ projectId, root, leaseId, action: "hold" }).catch(() => undefined);
    hold();
    const timer = setInterval(hold, LEASE_REFRESH_MS);
    return () => {
      disable();
      clearInterval(timer);
      void lease({ projectId, root, leaseId, action: "release" }).catch(() => undefined);
    };
  }, [projectId, root, lease]);
}
