import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { HIGHLIGHT_STYLES, paletteRpc } from "../shared/protocol";
import { isDark, legibleSyntax } from "./palette";

/** Colors by `HighlightStyle`, from the daemon's highlighter. */
export type SyntaxPalette = Readonly<Record<string, string>>;

export interface ColoredText {
  readonly text: string;
  readonly color: string | null;
}

/** Null until the daemon answers. */
export function useSyntaxPalette(theme: PluginTheme): SyntaxPalette | null {
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

export function coloredTokens(encoded: readonly number[], text: string, palette: SyntaxPalette): ColoredText[] {
  const tokens: ColoredText[] = [];
  let at = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    const style = HIGHLIGHT_STYLES[encoded[i + 1]];
    tokens.push({ text: text.slice(at, at + encoded[i]), color: style == null ? null : (palette[style] ?? null) });
    at += encoded[i];
  }
  if (at < text.length) tokens.push({ text: text.slice(at), color: null });
  return tokens;
}
