import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { FieldTrigger, ToolbarTrigger } from "./controls";
import { menuOffset } from "./menu-placement";

const NARROW_WIDTH = 720;
const BACKDROP_Z_INDEX = 5;
/** For the view holding the dropdowns, whose menus must paint over the backdrop and what follows. */
export const MENU_HOST_Z_INDEX = 10;

/** Render `MenuBackdrop` once, behind the dropdowns' host, so a press elsewhere closes it. No ancestor may clip the menu. */
export function Dropdown({
  theme,
  label,
  accessibilityLabel,
  icon,
  field,
  bounds,
  open,
  onOpenChange,
  children,
}: {
  theme: PluginTheme;
  label: string;
  accessibilityLabel?: string;
  icon?: string;
  field?: { disabled: boolean };
  /** Keeps the menu inside this view, which must contain the dropdown. */
  bounds: RefObject<View | null>;
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  const trigger = useRef<View>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const toggle = (): void => {
    if (!open) setOffset(null);
    onOpenChange(!open);
  };
  const place = (menuWidth: number): void => {
    const within = bounds.current;
    if (within == null) return;
    within.measure((_x, _y, width) => {
      // Relative to `bounds`: window coordinates put the menu off screen on a phone, and web's onLayout x goes stale on a move.
      trigger.current?.measureLayout(
        within,
        (left) => setOffset(menuOffset(left, width, menuWidth)),
        () => setOffset(0),
      );
    });
  };
  return (
    <View ref={trigger} collapsable={false}>
      {field == null ? (
        <ToolbarTrigger
          theme={theme}
          label={label}
          accessibilityLabel={accessibilityLabel}
          icon={icon}
          open={open}
          onPress={toggle}
        />
      ) : (
        <FieldTrigger
          theme={theme}
          label={label}
          accessibilityLabel={accessibilityLabel}
          open={open}
          disabled={field.disabled}
          onPress={toggle}
        />
      )}
      {open ? (
        <View
          accessibilityRole="menu"
          // Else a press in the menu's gaps reaches a responder behind it, which may close the menu.
          onStartShouldSetResponder={() => true}
          onLayout={(event) => place(event.nativeEvent.layout.width)}
          style={{
            position: "absolute",
            top: "100%",
            left: offset ?? 0,
            opacity: offset == null ? 0 : 1,
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

export function MenuBackdrop({ fillsWindow = false, onPress }: { fillsWindow?: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityLabel="Dismiss review menu"
      focusable={false}
      onPress={onPress}
      style={[
        StyleSheet.absoluteFill,
        { zIndex: BACKDROP_Z_INDEX },
        // RN's types lack "fixed"; react-native-web passes it through.
        fillsWindow && Platform.OS === "web" ? { position: "fixed" as "absolute" } : null,
      ]}
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
