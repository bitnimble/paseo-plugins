import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { ToolbarTrigger } from "./controls";

const NARROW_WIDTH = 720;
const EDGE_GAP = 8;

/** Render `MenuBackdrop` once under the toolbar so a press anywhere else in the panel closes it. */
export function Dropdown({
  theme,
  label,
  icon,
  open,
  onOpenChange,
  children,
}: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  const trigger = useRef<View>(null);
  const screen = useWindowDimensions();
  const [triggerLeft, setTriggerLeft] = useState<number | null>(null);
  const [menuWidth, setMenuWidth] = useState<number | null>(null);
  const placed = open && triggerLeft != null && menuWidth != null;
  const align = placed && triggerLeft + menuWidth > screen.width - EDGE_GAP ? "right" : "left";
  const toggle = (): void => {
    if (open) {
      onOpenChange(false);
      return;
    }
    setTriggerLeft(null);
    setMenuWidth(null);
    trigger.current?.measureInWindow((x) => setTriggerLeft(x));
    onOpenChange(true);
  };
  return (
    <View ref={trigger} collapsable={false}>
      <ToolbarTrigger theme={theme} label={label} icon={icon} open={open} onPress={toggle} />
      {open ? (
        <View
          accessibilityRole="menu"
          onLayout={(event) => setMenuWidth(event.nativeEvent.layout.width)}
          style={{
            position: "absolute",
            top: "100%",
            [align]: 0,
            opacity: placed ? 1 : 0,
            marginTop: 4,
            minWidth: 248,
            paddingVertical: 4,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            shadowColor: "#000",
            shadowOpacity: 0.2,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 4 },
          }}
        >
          {children}
        </View>
      ) : null}
    </View>
  );
}

export function MenuBackdrop({ onPress }: { onPress(): void }) {
  return (
    <Pressable
      accessibilityLabel="Dismiss review menu"
      focusable={false}
      onPress={onPress}
      style={[StyleSheet.absoluteFill, { zIndex: 5 }]}
    />
  );
}

export function MenuItem({
  theme,
  label,
  checked,
  hint,
  trailing,
  disabled = false,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  /** Omit for an action rather than an option. */
  checked?: boolean;
  hint?: string;
  trailing?: string;
  disabled?: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const narrow = useWindowDimensions().width < NARROW_WIDTH;
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={checked == null ? { disabled } : { checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: narrow ? 40 : 28,
        marginHorizontal: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        opacity: disabled ? 0.5 : 1,
        backgroundColor: (pressed || hovered) && !disabled ? theme.colors.surface2 : "transparent",
      })}
    >
      <View style={{ width: 14 }}>
        {checked === true ? <Icon name="Check" size={14} color={theme.colors.foreground} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, lineHeight: 18, color: theme.colors.foreground }}>{label}</Text>
        {hint == null ? null : <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>{hint}</Text>}
      </View>
      {trailing == null ? null : <Icon name={trailing} size={14} color={theme.colors.foregroundMuted} />}
    </Pressable>
  );
}

export function MenuHeading({ theme, children }: { theme: PluginTheme; children: string }) {
  return (
    <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted, paddingHorizontal: 12, paddingVertical: 4 }}>
      {children}
    </Text>
  );
}

export function MenuSeparator({ theme }: { theme: PluginTheme }) {
  return <View style={{ height: 1, marginVertical: 4, backgroundColor: theme.colors.border }} />;
}
