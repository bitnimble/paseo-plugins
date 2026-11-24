import type { PluginTheme } from "@getpaseo/plugin";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { Platform, Text, type TextStyle, View } from "react-native";
import type { FileBlock } from "../shared/blocks";
import { messageOf } from "../shared/errors";
import { hashText } from "../shared/hash";
import {
  MERMAID_MAX_DISTANCE,
  type MermaidOutcome,
  type MermaidPalette,
  mermaidDrawRpc,
  mermaidRpc,
} from "../shared/protocol";
import { blockSides } from "../shared/sides";
import { IconButton } from "./controls";
import type { FileText } from "./file-text";
import { usePackedRpc } from "./packed";
import { hexColor, isDark } from "./palette";
import { ZoomableImage } from "./zoomable-image";

// React Native's Image draws SVG only on the web.
const FORMAT = Platform.OS === "web" ? "svg" : "png";

/** A `.mmd` file's changes drawn over its new diagram. */
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
  const { outcome, pending } = useMermaidDiff(sides?.original.text ?? null, sides?.modified.text ?? null, distance, theme, true);
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

/**
 * `source` drawn as written, any kind of diagram; `fallback` shows under the reason it couldn't be.
 * With a different `before`, the changes are drawn over it where that kind of diagram can be diffed.
 */
export function MermaidDiagram({
  before,
  source,
  theme,
  noteStyle,
  fallback,
}: {
  before: string;
  source: string;
  theme: PluginTheme;
  noteStyle: TextStyle;
  fallback: ReactNode;
}) {
  const changed = before !== source;
  const diff = useMermaidDiff(changed ? before : null, changed ? source : null, MERMAID_MAX_DISTANCE, theme, false).outcome;
  const diffed = diff?.status === "ready" ? diff : null;
  const plain = useMermaidDraw(changed && (diff == null || diffed != null) ? null : source, theme);
  const outcome = diffed ?? plain;
  if (outcome?.status === "unavailable") {
    return (
      <>
        <Text style={noteStyle}>{outcome.reason}</Text>
        {fallback}
      </>
    );
  }
  if (outcome == null) return <Text style={noteStyle}>Drawing the diagram…</Text>;
  return (
    <ZoomableImage
      theme={theme}
      uri={outcome.uri}
      image={outcome}
      label={diffed == null ? "Diagram" : "Diagram changes"}
    />
  );
}

function useMermaidDiff(
  before: string | null,
  after: string | null,
  distance: number,
  theme: PluginTheme,
  /** Keeps the last picture up while the next loads, for stepping `distance`. */
  keepPrevious: boolean,
): { outcome: MermaidOutcome | null; pending: boolean } {
  const draw = usePackedRpc(mermaidRpc);
  const palette = useMermaidPalette(theme);
  const hashes = useMemo(() => [hashText(before ?? ""), hashText(after ?? "")], [before, after]);
  const query = useQuery({
    queryKey: ["review-mermaid", ...hashes, distance, FORMAT, JSON.stringify(palette)],
    queryFn: () => draw({ before: before ?? "", after: after ?? "", distance, format: FORMAT, palette }),
    enabled: before != null && after != null,
    staleTime: Infinity,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
  });
  return { outcome: settled(query.data, query.error), pending: query.isPlaceholderData };
}

function useMermaidDraw(source: string | null, theme: PluginTheme): MermaidOutcome | null {
  const draw = usePackedRpc(mermaidDrawRpc);
  const palette = useMermaidPalette(theme);
  const hash = useMemo(() => hashText(source ?? ""), [source]);
  const query = useQuery({
    queryKey: ["review-mermaid-draw", hash, FORMAT, JSON.stringify(palette)],
    queryFn: () => draw({ source: source ?? "", format: FORMAT, palette }),
    enabled: source != null,
    staleTime: Infinity,
  });
  return settled(query.data, query.error);
}

function settled(data: MermaidOutcome | undefined, error: Error | null): MermaidOutcome | null {
  if (data != null) return data;
  return error == null ? null : { status: "unavailable", reason: messageOf(error) };
}

function useMermaidPalette(theme: PluginTheme): MermaidPalette {
  return useMemo((): MermaidPalette => {
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
}
