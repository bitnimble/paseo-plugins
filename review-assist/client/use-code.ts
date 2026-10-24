import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { DiffFile } from "../shared/diff";
import { messageOf } from "../shared/errors";
import { fileRpc, highlightRpc, leaseRpc, lspRpc, monacoRpc, paletteRpc } from "../shared/protocol";
import { type CodeSource, reviewMonaco } from "./monaco/review-monaco";
import type { SyntaxPalette } from "./monaco/theme";
import { isDark, legibleSyntax } from "./palette";
import type { FileSyntax } from "./syntax";

const LEASE_REFRESH_MS = 30_000;

export type FileText =
  | { readonly status: "loading" }
  /** `previous` while the file's last text stands in for its new one. */
  | { readonly status: "ready"; readonly text: string; readonly previous: boolean }
  | { readonly status: "failed"; readonly error: string };

/** The file as the whole diff leaves it. */
export function useFileText(source: CodeSource, file: DiffFile, enabled: boolean): FileText {
  const read = useRpc(fileRpc);
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
  const highlight = useRpc(highlightRpc);
  const query = useQuery({
    queryKey: ["review-syntax", source.root, file.newBlob ?? source.tree, source.base, file.oldPath, file.newPath],
    queryFn: () =>
      highlight({ root: source.root, tree: source.tree, base: source.base, path: file.newPath, oldPath: file.oldPath }),
    enabled,
    staleTime: Infinity,
  });
  return query.data?.status === "ready" ? query.data : null;
}

export function usePalette(theme: PluginTheme): SyntaxPalette | null {
  const read = useRpc(paletteRpc);
  const scheme = isDark(theme) ? "dark" : "light";
  const query = useQuery({
    queryKey: ["review-palette", scheme],
    queryFn: () => read({ scheme }),
    staleTime: Infinity,
  });
  const colors = query.data?.colors;
  return useMemo(() => (colors == null ? null : legibleSyntax(theme, colors)), [theme, colors]);
}

/** Connects Monaco to the daemon; `trustedRoot` adds language features for its files. */
export function useCodeIntelligence(trustedRoot: string | null): void {
  const read = useRpc(fileRpc);
  const lsp = useRpc(lspRpc);
  const lease = useRpc(leaseRpc);
  const monaco = useRpc(monacoRpc);

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
  }, [read, lsp, monaco]);

  useEffect(() => {
    if (trustedRoot == null) return;
    const disable = reviewMonaco.enableLanguageFeatures(trustedRoot);
    const leaseId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const hold = () => void lease({ root: trustedRoot, leaseId, action: "hold" }).catch(() => undefined);
    hold();
    const timer = setInterval(hold, LEASE_REFRESH_MS);
    return () => {
      disable();
      clearInterval(timer);
      void lease({ root: trustedRoot, leaseId, action: "release" }).catch(() => undefined);
    };
  }, [trustedRoot, lease]);
}
