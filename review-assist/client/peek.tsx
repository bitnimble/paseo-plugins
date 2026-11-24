import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Markdown } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { createContext, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { usePackedRpc } from "../kit/client/packed";
import { CODE_SURFACE, MONOSPACE, tint } from "../kit/client/palette";
import { messageOf } from "../kit/shared/errors";
import type { LspPosition } from "../shared/lsp";
import { type PeekLocation, type PeekOutcome, peekRpc } from "../shared/protocol";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT } from "./diff-styles";
import type { CodeSource } from "./monaco/review-monaco";
import type { SyntaxPalette } from "./monaco/theme";
import { codePieces, coloredTokens, expandTabs } from "./syntax";

/** Set once the project is trusted, for language features against its language servers. */
export const LanguageFeatures = createContext<{ readonly projectId: string } | null>(null);

export interface PeekTarget {
  /** 1-based, in the new file. */
  readonly line: number;
  readonly character: number;
  readonly word: string;
}

const FRAME_WIDTH = Math.round(CODE_LINE_HEIGHT / 9);
const HEAD_HEIGHT = Math.ceil(CODE_LINE_HEIGHT * 1.2);
const MATCH_ALPHA = 0.3;

export function PeekView({
  source,
  projectId,
  path,
  target,
  theme,
  palette,
  onClose,
}: {
  source: CodeSource;
  projectId: string;
  path: string;
  target: PeekTarget;
  theme: PluginTheme;
  palette: SyntaxPalette | null;
  onClose(): void;
}) {
  const styles = useMemo(() => createPeekStyles(theme), [theme]);
  const outcome = usePeek(source, projectId, path, { line: target.line - 1, character: target.character });
  const [shown, setShown] = useState(0);
  const locations = outcome?.status === "ok" ? outcome.locations : [];
  const location: PeekLocation | undefined = locations[Math.min(shown, locations.length - 1)];
  const hover = outcome?.status === "ok" ? outcome.hover : null;
  const { name, directory } = location == null ? { name: target.word, directory: "" } : splitPath(location.path);
  const meta = locations.length > 1 ? `${shown + 1} of ${locations.length} definitions` : "";
  const iconColor = theme.colors.foregroundMuted;

  return (
    <View style={styles.frame} dataSet={CODE_SURFACE}>
      <View style={styles.head}>
        <Text style={styles.title} numberOfLines={1}>
          <Text style={styles.filename}>{name}</Text>
          {directory === "" ? null : <Text style={styles.description}>{` ${directory}`}</Text>}
          {meta === "" ? null : <Text style={styles.description}>{` - ${meta}`}</Text>}
        </Text>
        {locations.length > 1 ? (
          <>
            <HeadAction
              icon="ChevronUp"
              label="Previous definition"
              color={iconColor}
              onPress={() => setShown((shown + locations.length - 1) % locations.length)}
            />
            <HeadAction
              icon="ChevronDown"
              label="Next definition"
              color={iconColor}
              onPress={() => setShown((shown + 1) % locations.length)}
            />
          </>
        ) : null}
        <HeadAction icon="X" label="Close" color={iconColor} onPress={onClose} />
      </View>
      {hover == null ? null : (
        <View style={styles.hover}>
          <Markdown>{hover}</Markdown>
        </View>
      )}
      {location == null ? (
        <Text style={styles.message}>{peekMessage(outcome, target.word)}</Text>
      ) : (
        <PeekLines location={location} palette={palette} styles={styles} />
      )}
    </View>
  );
}

function usePeek(source: CodeSource, projectId: string, path: string, position: LspPosition): PeekOutcome | null {
  const read = usePackedRpc(peekRpc);
  const query = useQuery({
    queryKey: ["review-peek", source.root, source.tree, path, position.line, position.character],
    queryFn: () => read({ projectId, root: source.root, tree: source.tree, path, position }),
    // Windowing remounts the row as it scrolls back in: keep an answer rather than reloading, but ask again after
    // a failure or an empty one, as from a language server still starting.
    staleTime: ({ state }) => (state.data?.status === "ok" && state.data.locations.length > 0 ? Infinity : 0),
  });
  if (query.error != null) return { status: "failed", error: messageOf(query.error) };
  return query.data ?? null;
}

function peekMessage(outcome: PeekOutcome | null, word: string): string {
  if (outcome == null) return "Finding the definition…";
  if (outcome.status === "unsupported") return "No language server for this file.";
  if (outcome.status === "failed") return outcome.error;
  return `No definition found for '${word}'`;
}

function HeadAction({ icon, label, color, onPress }: { icon: string; label: string; color: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={8} onPress={onPress} style={{ padding: 3 }}>
      <Icon name={icon} size={14} color={color} />
    </Pressable>
  );
}

function PeekLines({
  location,
  palette,
  styles,
}: {
  location: PeekLocation;
  palette: SyntaxPalette | null;
  styles: PeekStyles;
}) {
  const { first, lines, tokens, range } = location;
  const gutter = String(first + lines.length).length * Math.ceil(CODE_FONT_SIZE * 0.62) + 12;
  return (
    <View style={styles.body}>
      {lines.map((text, i) => {
        const number = first + i;
        const encoded = tokens?.[i];
        const colored = encoded == null || palette == null ? [{ text, color: null }] : coloredTokens(encoded, text, palette);
        const start = number === range.start.line ? range.start.character : 0;
        const end = number === range.end.line ? range.end.character : text.length;
        const matched = number >= range.start.line && number <= range.end.line && end > start ? [{ start, end }] : [];
        return (
          <View key={number} style={styles.row}>
            <Text style={[styles.number, { width: gutter }]}>{number + 1}</Text>
            <Text style={styles.code}>
              {codePieces(colored, matched, false).map((piece) => (
                <Text
                  key={piece.start}
                  style={[piece.color == null ? undefined : { color: piece.color }, piece.marked && styles.match]}
                >
                  {expandTabs(piece.text)}
                </Text>
              ))}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function splitPath(path: string): { name: string; directory: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, directory: "" } : { name: path.slice(slash + 1), directory: path.slice(0, slash) };
}

type PeekStyles = ReturnType<typeof createPeekStyles>;

function createPeekStyles(theme: PluginTheme) {
  const { colors } = theme;
  const code = { fontFamily: MONOSPACE, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT } as const;
  return StyleSheet.create({
    frame: {
      borderTopWidth: FRAME_WIDTH,
      borderBottomWidth: FRAME_WIDTH,
      borderColor: colors.accent,
      backgroundColor: colors.surface1,
    },
    head: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
      minHeight: HEAD_HEIGHT,
      paddingLeft: 20,
      paddingRight: 4,
      backgroundColor: colors.surface2,
    },
    title: { flex: 1, fontSize: 13 },
    filename: { color: colors.foreground },
    description: { fontSize: 13 * 0.9, color: colors.foregroundMuted },
    hover: {
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    message: { ...code, paddingHorizontal: 20, paddingVertical: 6, color: colors.foregroundMuted },
    body: { paddingVertical: 2 },
    row: { flexDirection: "row" },
    number: { ...code, color: colors.foregroundMuted, textAlign: "right", paddingRight: 7 },
    code: { ...code, flex: 1, flexShrink: 1, paddingHorizontal: 8, color: colors.foreground },
    match: { backgroundColor: tint(colors.accent, MATCH_ALPHA) },
  });
}
