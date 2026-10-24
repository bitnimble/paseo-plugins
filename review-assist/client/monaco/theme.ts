import type { HighlightStyle } from "@getpaseo/highlight";
import type { PluginTheme } from "@getpaseo/plugin";
import { IN_SCOPE_ALPHA, diffAlpha, hexTint, isDark } from "../palette";
import type { MonacoThemeData } from "./api";

export const THEME_NAME = "paseo-review";

/** Colors by `HighlightStyle`, from the daemon's highlighter. */
export type SyntaxPalette = Readonly<Record<string, string>>;

/** Monarch token prefixes to the roles Paseo's highlighter colors; the most specific prefix wins. */
const TOKEN_ROLES: readonly (readonly [string, HighlightStyle])[] = [
  ["comment", "comment"],
  ["keyword", "keyword"],
  ["string", "string"],
  ["string.escape", "escape"],
  ["string.key", "property"],
  ["string.link", "link"],
  ["number", "number"],
  ["regexp", "regexp"],
  ["type", "type"],
  ["type.identifier", "class"],
  ["namespace", "class"],
  ["tag", "tag"],
  ["metatag", "meta"],
  ["annotation", "meta"],
  ["attribute.name", "attribute"],
  ["attribute.value", "string"],
  ["key", "property"],
  ["delimiter", "punctuation"],
  ["operator", "operator"],
  ["identifier", "variable"],
  ["variable", "variable"],
  ["variable.predefined", "literal"],
  ["constant", "literal"],
  ["predefined", "function"],
];

export function monacoTheme(theme: PluginTheme, palette: SyntaxPalette): MonacoThemeData {
  const { colors } = theme;
  const solid = (color: string) => hexTint(color);
  const alpha = diffAlpha(theme);
  return {
    base: isDark(theme) ? "vs-dark" : "vs",
    inherit: true,
    rules: TOKEN_ROLES.map(([token, role]) => ({
      token,
      foreground: solid(palette[role] ?? colors.foreground).slice(1, 7),
    })),
    colors: {
      "editor.background": solid(colors.surface0),
      "editor.foreground": solid(colors.foreground),
      "editorGutter.background": solid(colors.surface0),
      "editorLineNumber.foreground": solid(colors.foregroundMuted),
      "editorLineNumber.activeForeground": solid(colors.foreground),
      "editor.lineHighlightBackground": hexTint(colors.surface0, 0),
      "editor.lineHighlightBorder": hexTint(colors.surface0, 0),
      "editor.rangeHighlightBackground": hexTint(colors.foreground, IN_SCOPE_ALPHA.fill),
      "editor.rangeHighlightBorder": hexTint(colors.foreground, IN_SCOPE_ALPHA.edge),
      focusBorder: hexTint(colors.accent, 0.6),
      "diffEditor.insertedLineBackground": hexTint(colors.statusSuccess, alpha.addLine),
      "diffEditor.removedLineBackground": hexTint(colors.statusDanger, alpha.delLine),
      "diffEditor.insertedTextBackground": hexTint(colors.statusSuccess, alpha.addMark),
      "diffEditor.removedTextBackground": hexTint(colors.statusDanger, alpha.delMark),
      "diffEditorGutter.insertedLineBackground": hexTint(colors.statusSuccess, 0.2),
      "diffEditorGutter.removedLineBackground": hexTint(colors.statusDanger, 0.15),
      "diffEditor.border": solid(colors.border),
      "diffEditor.unchangedRegionBackground": solid(colors.surface1),
      "diffEditor.unchangedRegionForeground": solid(colors.foregroundMuted),
      "diffEditor.unchangedCodeBackground": hexTint(colors.surface1, 0.4),
      "editorWidget.background": solid(colors.surface1),
      "editorWidget.border": solid(colors.border),
      "editorHoverWidget.background": solid(colors.surface1),
      "editorHoverWidget.border": solid(colors.border),
      "peekView.border": solid(colors.accent),
      "peekViewTitle.background": solid(colors.surface2),
      "peekViewTitleLabel.foreground": solid(colors.foreground),
      "peekViewTitleDescription.foreground": solid(colors.foregroundMuted),
      "peekViewEditor.background": solid(colors.surface1),
      "peekViewEditorGutter.background": solid(colors.surface1),
      "peekViewResult.background": solid(colors.surface0),
      "peekViewResult.selectionBackground": hexTint(colors.accent, 0.25),
      "peekViewEditor.matchHighlightBackground": hexTint(colors.accent, 0.3),
      "peekViewResult.matchHighlightBackground": hexTint(colors.accent, 0.3),
      "scrollbarSlider.background": hexTint(colors.foregroundMuted, 0.2),
      "scrollbarSlider.hoverBackground": hexTint(colors.foregroundMuted, 0.35),
      "scrollbarSlider.activeBackground": hexTint(colors.foregroundMuted, 0.5),
    },
  };
}
