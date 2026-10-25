import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { DiffFile } from "../shared/diff";
import { MORE_CHANGES_STEP } from "../shared/sides";
import { changeIcon, compactCount, formatBytes, statusTint, tint } from "./palette";

export function Tabs<Value extends string>({
  theme,
  value,
  options,
  onChange,
  compact = false,
}: {
  theme: PluginTheme;
  value: Value;
  options: readonly { value: Value; label: string }[];
  onChange(value: Value): void;
  compact?: boolean;
}) {
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: compact ? 2 : 4 }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              height: compact ? 22 : 28,
              justifyContent: "center",
              paddingHorizontal: compact ? 6 : 8,
              borderRadius: 6,
              backgroundColor: selected ? theme.colors.surface2 : pressed ? theme.colors.surface1 : "transparent",
            })}
          >
            <Text
              style={{
                fontSize: compact ? 12 : 14,
                color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ToolbarTrigger({
  theme,
  label,
  icon,
  open,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  /** Set when it opens a menu: adds the chevron and expanded state. */
  open?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={open == null ? undefined : { expanded: open }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        padding: 4,
        borderRadius: 6,
        backgroundColor: open || pressed ? theme.colors.surface1 : "transparent",
      })}
    >
      {icon == null ? null : <Icon name={icon} size={12} color={theme.colors.foregroundMuted} />}
      <Text style={{ fontSize: 12, color: open === true ? theme.colors.foreground : theme.colors.foregroundMuted }}>
        {label}
      </Text>
      {open == null ? null : <Icon name="ChevronDown" size={12} color={theme.colors.foregroundMuted} />}
    </Pressable>
  );
}

export function IconButton({
  theme,
  icon,
  label,
  disabled = false,
  tooltipSide = "end",
  onPress,
}: {
  theme: PluginTheme;
  icon: string;
  /** Also shown as a tooltip on hover. */
  label: string;
  disabled?: boolean;
  /** Which of the button's edges the tooltip lines up with; "start" for buttons at a pane's left edge. */
  tooltipSide?: "start" | "end";
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => ({
          padding: 6,
          borderRadius: 6,
          opacity: disabled ? 0.5 : 1,
          backgroundColor: pressed || hovered ? theme.colors.surface1 : "transparent",
        })}
      >
        <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
      {hovered ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: "100%",
            ...(tooltipSide === "start" ? { left: 0 } : { right: 0 }),
            zIndex: 1,
            marginTop: 6,
            paddingVertical: 4,
            paddingHorizontal: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <Text numberOfLines={1} style={{ fontSize: 12, color: theme.colors.foreground }}>
            {label}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

type ButtonVariant = "default" | "outline" | "ghost";

const BUTTON_SIZES = {
  xs: { minHeight: 28, fontSize: 12, icon: 12 },
  sm: { minHeight: 32, fontSize: 14, icon: 14 },
} as const;

export function Button({
  theme,
  label,
  icon,
  variant = "outline",
  size = "sm",
  disabled = false,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZES;
  disabled?: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const { minHeight, fontSize, icon: iconSize } = BUTTON_SIZES[size];
  const { colors } = theme;
  const look = {
    default: { fill: colors.accent, edge: colors.accent, color: colors.accentForeground },
    outline: { fill: "transparent", edge: colors.border, color: colors.foreground },
    ghost: { fill: "transparent", edge: "transparent", color: hovered ? colors.foreground : colors.foregroundMuted },
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minHeight,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: look.edge,
        backgroundColor: look.fill,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {icon == null ? null : <Icon name={icon} size={iconSize} color={look.color} />}
      <Text style={{ fontSize, color: look.color }}>{label}</Text>
    </Pressable>
  );
}

export function Notice({
  theme,
  tone = "default",
  icon: iconName,
  children,
  actions,
}: {
  theme: PluginTheme;
  tone?: "default" | "progress" | "warning" | "danger";
  icon?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const toneIcon =
    tone === "danger"
      ? { name: "CircleAlert", color: theme.colors.statusDanger }
      : tone === "warning"
        ? { name: "TriangleAlert", color: theme.colors.statusWarning }
        : { name: "Info", color: theme.colors.foregroundMuted };
  const icon = { ...toneIcon, name: iconName ?? toneIcon.name };
  const alertColor = tone === "warning" || tone === "danger" ? icon.color : null;
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        alignContent: "center",
        gap: 8,
        // Room for an xs action, so a notice keeps its height when actions come and go.
        minHeight: BUTTON_SIZES.xs.minHeight + 2 * 6 + 1,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderBottomColor: alertColor == null ? theme.colors.border : tint(alertColor, 0.5),
        borderLeftWidth: alertColor == null ? 0 : 3,
        borderLeftColor: alertColor ?? undefined,
        backgroundColor: alertColor == null ? theme.colors.surface1 : statusTint(theme, alertColor),
      }}
    >
      {tone === "progress" ? (
        <ActivityIndicator size={14} color={theme.colors.foregroundMuted} />
      ) : (
        <Icon name={icon.name} size={14} color={icon.color} />
      )}
      <Text style={{ flex: 1, minWidth: 200, fontSize: 14, color: theme.colors.foreground }}>{children}</Text>
      {actions}
    </View>
  );
}

export function ShowMoreChanges({ theme, hidden, onPress }: { theme: PluginTheme; hidden: number; onPress(): void }) {
  return (
    <View
      style={{
        alignItems: "center",
        paddingVertical: 4,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Button
        theme={theme}
        size="xs"
        variant="ghost"
        icon="ChevronsUpDown"
        label={
          hidden > MORE_CHANGES_STEP
            ? `Show ${MORE_CHANGES_STEP.toLocaleString()} more lines (${hidden.toLocaleString()} hidden)`
            : `Show full diff (${hidden.toLocaleString()} more lines)`
        }
        onPress={onPress}
      />
    </View>
  );
}

export function FileLabel({ theme, path, detail }: { theme: PluginTheme; path: string; detail?: string }) {
  const slash = path.lastIndexOf("/");
  const directory = slash < 0 ? "" : path.slice(0, slash);
  const muted = [directory, detail].filter((part) => part != null && part !== "").join(" ");
  return (
    <Text style={{ flex: 1, fontSize: 14, color: theme.colors.foreground }} numberOfLines={1}>
      {path.slice(slash + 1)}
      {muted === "" ? null : <Text style={{ color: theme.colors.foregroundMuted }}> {muted}</Text>}
    </Text>
  );
}

export function ChangeStats({
  theme,
  file,
  additions,
  deletions,
}: {
  theme: PluginTheme;
  file: DiffFile;
  additions: number;
  deletions: number;
}) {
  const icon = changeIcon(theme, file.status);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {file.binary || file.lfs ? (
        <SizeChange theme={theme} change={file.sizeChange} />
      ) : (
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Text style={{ fontSize: 12, color: theme.colors.statusSuccess }}>+{compactCount(additions)}</Text>
          <Text style={{ fontSize: 12, color: theme.colors.statusDanger }}>-{compactCount(deletions)}</Text>
        </View>
      )}
      <Icon name={icon.name} size={14} color={icon.color} />
    </View>
  );
}

function SizeChange({ theme, change }: { theme: PluginTheme; change: number | null }) {
  if (change == null) return null;
  const { colors } = theme;
  const [sign, color] =
    change > 0 ? ["+", colors.statusSuccess] : change < 0 ? ["-", colors.statusDanger] : ["", colors.foregroundMuted];
  return (
    <Text style={{ fontSize: 12, color }}>
      {sign}
      {formatBytes(Math.abs(change))}
    </Text>
  );
}
