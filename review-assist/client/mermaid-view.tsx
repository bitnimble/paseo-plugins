import type { PluginTheme } from "@getpaseo/plugin";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { Platform, Text, type TextStyle, View } from "react-native";
import { messageOf } from "../shared/errors";
import type { FileBlock } from "../shared/guide";
import { hashText } from "../shared/hash";
import {
  MERMAID_MAX_DISTANCE,
  type MermaidOutcome,
  type MermaidPalette,
  mermaidRpc,
} from "../shared/protocol";
import { blockSides } from "../shared/sides";
import { IconButton } from "./controls";
import { usePackedRpc } from "./packed";
import { hexColor, isDark } from "./palette";
import type { FileText } from "./use-code";
import { ZoomableImage } from "./zoomable-image";

export function MermaidBody({
  block,
  text,
  theme,
  distance,
  onDistance,
  noteStyle,
  fallback,
}: {
  block: FileBlock;
  text: FileText;
  theme: PluginTheme;
  distance: number;
  onDistance: (distance: number) => void;
  noteStyle: TextStyle;
  fallback: ReactNode;
}) {
  // The file's previous text, standing in while its new one loads, doesn't match the new hunks.
  const current = text.status === "ready" && !text.previous ? text.text : null;
  const sides = useMemo(() => (current == null ? null : blockSides(block, current, false)), [block, current]);
  const { outcome, pending } = useMermaidDiff(sides?.original.text ?? null, sides?.modified.text ?? null, distance, theme);
  const reason = text.status === "failed" ? text.error : outcome?.status === "unavailable" ? outcome.reason : null;
  if (reason != null) {
    return (
      <>
        <Text style={noteStyle}>{reason}</Text>
        {fallback}
      </>
    );
  }
  if (outcome?.status !== "ready") return <Text style={noteStyle}>Drawing the diagram…</Text>;
  return (
    <View style={{ padding: 12 }}>
      <ZoomableImage
        theme={theme}
        uri={outcome.uri}
        image={outcome}
        label="Diagram changes"
        leading={
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <IconButton
              theme={theme}
              icon="Minus"
              label="Show fewer neighbours"
              tooltipSide="start"
              disabled={pending || distance <= 1}
              onPress={() => onDistance(distance - 1)}
            />
            <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>Context</Text>
            <IconButton
              theme={theme}
              icon="Plus"
              label="Show more neighbours"
              tooltipSide="start"
              disabled={pending || !outcome.truncated || distance >= MERMAID_MAX_DISTANCE}
              onPress={() => onDistance(distance + 1)}
            />
          </View>
        }
      />
    </View>
  );
}

function useMermaidDiff(
  before: string | null,
  after: string | null,
  distance: number,
  theme: PluginTheme,
): { outcome: MermaidOutcome | null; pending: boolean } {
  const draw = usePackedRpc(mermaidRpc);
  const palette = useMemo((): MermaidPalette => {
    const { colors } = theme;
    return {
      dark: isDark(theme),
      background: hexColor(colors.surface0),
      surface: hexColor(colors.surface1),
      foreground: hexColor(colors.foreground),
      muted: hexColor(colors.foregroundMuted),
      border: hexColor(colors.border),
      added: hexColor(colors.statusSuccess),
      removed: hexColor(colors.statusDanger),
      changed: hexColor(colors.statusWarning),
    };
  }, [theme]);
  // React Native's Image draws SVG only on the web.
  const format = Platform.OS === "web" ? "svg" : "png";
  const hashes = useMemo(() => [hashText(before ?? ""), hashText(after ?? "")], [before, after]);
  const query = useQuery({
    queryKey: ["review-mermaid", ...hashes, distance, format, JSON.stringify(palette)],
    queryFn: () => draw({ before: before ?? "", after: after ?? "", distance, format, palette }),
    enabled: before != null && after != null,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const pending = query.isPlaceholderData;
  if (query.data != null) return { outcome: query.data, pending };
  return { outcome: query.error == null ? null : { status: "unavailable", reason: messageOf(query.error) }, pending };
}
