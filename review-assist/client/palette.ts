import type { PluginTheme } from "@getpaseo/plugin";
import { Platform } from "react-native";
import type { DiffFileStatus } from "../shared/diff";
import type { SyntaxPalette } from "./monaco/theme";

export const MONOSPACE = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
});

// Paseo's web stylesheet forces its UI font outside `[data-pmono]` subtrees. Mark code only:
// UI inside one, such as a comment card, falls back to a different font.
export const CODE_SURFACE = { pmono: "" } as const;

export function changeIcon(theme: PluginTheme, status: DiffFileStatus): { name: string; color: string } {
  if (status === "added") return { name: "SquarePlus", color: theme.colors.statusSuccess };
  if (status === "deleted") return { name: "SquareMinus", color: theme.colors.statusDanger };
  return { name: "SquareDot", color: theme.colors.statusWarning };
}

export function compactCount(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const IN_SCOPE_ALPHA = { fill: 0.1, edge: 0.5 } as const;

const MIN_DARK_SYNTAX_CONTRAST = 3;
const LIFT_STEPS = 20;

export interface DiffAlpha {
  readonly addLine: number;
  readonly delLine: number;
  readonly addMark: number;
  readonly delMark: number;
}

export function diffAlpha(theme: PluginTheme): DiffAlpha {
  const dark = isDark(theme);
  return { addLine: 0.15, delLine: 0.1, addMark: dark ? 0.2 : 0.3, delMark: dark ? 0.18 : 0.25 };
}

/** On dark themes, each syntax color lifted toward the foreground until it reads on a changed word's mark. */
export function legibleSyntax(theme: PluginTheme, palette: SyntaxPalette): SyntaxPalette {
  const { colors } = theme;
  const surface = parseColor(colors.surface0);
  const foreground = parseColor(colors.foreground);
  const added = parseColor(colors.statusSuccess);
  const removed = parseColor(colors.statusDanger);
  if (!isDark(theme) || surface == null || foreground == null || added == null || removed == null) return palette;
  const alpha = diffAlpha(theme);
  const marks = [
    blend(added, alpha.addMark, blend(added, alpha.addLine, surface)),
    blend(removed, alpha.delMark, blend(removed, alpha.delLine, surface)),
  ];
  const legible = (color: Rgb): boolean => marks.every((mark) => contrast(color, mark) >= MIN_DARK_SYNTAX_CONTRAST);
  return Object.fromEntries(
    Object.entries(palette).map(([role, color]) => {
      const rgb = parseColor(color);
      if (rgb == null) return [role, color];
      let lifted: Rgb = rgb;
      for (let step = 1; step <= LIFT_STEPS && !legible(lifted); step++) lifted = blend(foreground, step / LIFT_STEPS, rgb);
      return [role, toHex(lifted).slice(0, 7)];
    }),
  );
}

/** Transparent for colors that are neither hex nor rgb. */
export function tint(color: string, alpha: number): string {
  const rgb = parseColor(color);
  return rgb == null ? "transparent" : `rgba(${rgb.join(", ")}, ${alpha})`;
}

/** `#rrggbbaa`, the only form Monaco themes accept. */
export function hexTint(color: string, alpha = 1): string {
  const rgb = parseColor(color);
  return rgb == null ? "#00000000" : toHex(rgb, alpha);
}

function toHex(rgb: Rgb, alpha = 1): string {
  return `#${[...rgb, alpha * 255].map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}`;
}

/** `#rrggbb`, black for colors that are neither hex nor rgb. */
export function hexColor(color: string): string {
  return hexTint(color).slice(0, 7);
}

export function isDark(theme: PluginTheme): boolean {
  const rgb = parseColor(theme.colors.surface0);
  return rgb == null || 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 128;
}

type Rgb = readonly [number, number, number];

function blend(top: Rgb, alpha: number, base: Rgb): Rgb {
  const mix = (i: 0 | 1 | 2): number => top[i] * alpha + base[i] * (1 - alpha);
  return [mix(0), mix(1), mix(2)];
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((part) => {
    const s = part / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseColor(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex != null) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
    const value = parseInt(digits, 16);
    return [value >> 16, (value >> 8) & 255, value & 255];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (rgb == null) return null;
  const [r, g, b] = rgb[1].split(/[\s,/]+/).map(Number);
  return [r, g, b].every((part) => Number.isFinite(part)) ? [r, g, b] : null;
}
