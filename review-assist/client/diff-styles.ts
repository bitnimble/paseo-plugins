import type { PluginTheme } from "@getpaseo/plugin";
import { StyleSheet } from "react-native";
import { IN_SCOPE_ALPHA, MONOSPACE, diffAlpha, tint } from "./palette";

export const CODE_FONT_SIZE = 12;
export const CODE_LINE_HEIGHT = 18;

export type DiffStyles = ReturnType<typeof createStyles>;

export function createStyles(theme: PluginTheme) {
  const { colors } = theme;
  const alpha = diffAlpha(theme);
  const code = { fontFamily: MONOSPACE, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT } as const;
  const row = { flexDirection: "row" } as const;
  const number = {
    ...code,
    color: colors.foregroundMuted,
    textAlign: "right",
    paddingRight: 7,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  } as const;
  return StyleSheet.create({
    list: { flex: 1, backgroundColor: colors.surface0 },
    overflowHost: { position: "absolute", top: 0, left: 0, width: 0, height: 0, zIndex: 20 },
    fileHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 30,
      paddingLeft: 12,
      paddingRight: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.surface0,
    },
    fileHeaderPressed: { backgroundColor: colors.surface1 },
    commentCount: { flexDirection: "row", alignItems: "center", gap: 4 },
    viewedToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      height: 22,
      paddingHorizontal: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
    },
    viewedLabel: { fontSize: 12, color: colors.foregroundMuted },
    body: { borderBottomWidth: 1, borderBottomColor: colors.border },
    row,
    addRow: { ...row, backgroundColor: tint(colors.statusSuccess, alpha.addLine) },
    delRow: { ...row, backgroundColor: tint(colors.statusDanger, alpha.delLine) },
    inScope: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: tint(colors.foreground, IN_SCOPE_ALPHA.fill),
      borderColor: tint(colors.foreground, IN_SCOPE_ALPHA.edge),
      borderLeftWidth: 1,
      borderRightWidth: 1,
    },
    gap: { alignItems: "center", backgroundColor: colors.surface1 },
    gapButtons: { flexDirection: "row", justifyContent: "center", gap: 4, borderRightWidth: 1, borderRightColor: colors.border },
    gapLabel: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 8 },
    inScopeFirst: { borderTopWidth: 1 },
    inScopeLast: { borderBottomWidth: 1 },
    splitCell: { ...row, flex: 1, flexBasis: 0 },
    splitDivider: { width: 1, backgroundColor: colors.border },
    number,
    addMark: { backgroundColor: tint(colors.statusSuccess, alpha.addMark) },
    delMark: { backgroundColor: tint(colors.statusDanger, alpha.delMark) },
    addNumber: { ...number, color: colors.statusSuccess },
    delNumber: { ...number, color: colors.statusDanger },
    code: { ...code, flex: 1, flexShrink: 1, paddingHorizontal: 8, color: colors.foreground },
    codeSideways: { ...code, paddingHorizontal: 8, color: colors.foreground },
    mutedCode: { ...code, flex: 1, paddingHorizontal: 8, color: colors.foregroundMuted },
    note: { fontSize: 12, lineHeight: 18, paddingHorizontal: 12, paddingVertical: 6, color: colors.foregroundMuted },
  });
}
