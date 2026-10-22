import type { PluginTheme } from "@getpaseo/plugin";
import { Platform } from "react-native";
import type { DiffFileStatus } from "../shared/diff";

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

/** Transparent for colors that are neither hex nor rgb. */
export function tint(color: string, alpha: number): string {
  const rgb = parseColor(color);
  return rgb == null ? "transparent" : `rgba(${rgb.join(", ")}, ${alpha})`;
}

/** `#rrggbbaa`, the only form Monaco themes accept. */
export function hexTint(color: string, alpha = 1): string {
  const rgb = parseColor(color);
  if (rgb == null) return "#00000000";
  return `#${[...rgb, Math.round(alpha * 255)].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

/** `#rrggbb`, black for colors that are neither hex nor rgb. */
export function hexColor(color: string): string {
  return hexTint(color).slice(0, 7);
}

export function isDark(theme: PluginTheme): boolean {
  const rgb = parseColor(theme.colors.surface0);
  return rgb == null || 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 128;
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
