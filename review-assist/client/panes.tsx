import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import type { DiffFile } from "../shared/diff";
import type { ViewOptions } from "../shared/settings";
import { treeRows } from "../shared/tree";
import { ChangeStats, FileLabel } from "./controls";

const MIN_PANE_WIDTH = 180;
const MAX_PANE_WIDTH = 640;
const TREE_INDENT = 12;
const CHEVRON_SPACE = 22;
const RESIZE_HANDLE = { reviewresize: "" } as const;

export function Split({
  theme,
  compact,
  paneWidth,
  onResizePane,
  paneLabel,
  pane,
  children,
}: {
  theme: PluginTheme;
  compact: boolean;
  paneWidth: number;
  onResizePane(width: number): void;
  paneLabel: string;
  pane: (close: () => void) => ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [dragged, setDragged] = useState<number | null>(null);
  if (!compact) {
    const width = dragged ?? clampPane(paneWidth);
    return (
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ width, borderRightWidth: 1, borderRightColor: theme.colors.border }}>
          <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>{pane(() => undefined)}</ScrollView>
          <ResizeHandle
            theme={theme}
            width={width}
            onDrag={setDragged}
            onDrop={(next) => {
              setDragged(null);
              onResizePane(next);
            }}
          />
        </View>
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 36,
          paddingHorizontal: 12,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          backgroundColor: pressed ? theme.colors.surface1 : theme.colors.surface0,
        })}
      >
        <Icon name={open ? "X" : "PanelLeft"} size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ flex: 1, fontSize: 14, color: theme.colors.foreground }} numberOfLines={1}>
          {open ? "Close" : paneLabel}
        </Text>
      </Pressable>
      <View style={{ flex: 1 }}>
        {children}
        {/* Over the diff, not instead of it, so a comment being written survives a look at the list. */}
        {open ? (
          <ScrollView style={{ ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.surface0 }}>
            {pane(() => setOpen(false))}
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

function ResizeHandle({
  theme,
  width,
  onDrag,
  onDrop,
}: {
  theme: PluginTheme;
  width: number;
  onDrag(width: number): void;
  onDrop(width: number): void;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef(width);
  const latest = useRef({ width, onDrag, onDrop });
  latest.current = { width, onDrag, onDrop };
  const responder = useMemo(() => {
    const finish = (dx: number) => {
      setDragging(false);
      latest.current.onDrop(clampPane(start.current + dx));
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        start.current = latest.current.width;
        setDragging(true);
      },
      onPanResponderMove: (_, { dx }) => latest.current.onDrag(clampPane(start.current + dx)),
      onPanResponderRelease: (_, { dx }) => finish(dx),
      onPanResponderTerminate: (_, { dx }) => finish(dx),
    });
  }, []);
  return (
    <View
      {...responder.panHandlers}
      accessibilityLabel="Resize the file list"
      dataSet={RESIZE_HANDLE}
      style={{ position: "absolute", top: 0, bottom: 0, right: -4, width: 7, alignItems: "center", zIndex: 2 }}
    >
      {dragging ? <View style={{ width: 2, flex: 1, backgroundColor: theme.colors.foregroundMuted }} /> : null}
    </View>
  );
}

function clampPane(width: number): number {
  return Math.round(Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, width)));
}

export function PaneHeading({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: 6,
      }}
    >
      {children}
    </Text>
  );
}

export interface FileEntry {
  readonly file: DiffFile;
  readonly additions: number;
  readonly deletions: number;
  /** Leave unset where files have no viewed state. */
  readonly viewed?: boolean;
  readonly comments?: number;
  onPress(): void;
}

export function FileList({
  theme,
  layout,
  entries,
  indent = 0,
}: {
  theme: PluginTheme;
  layout: ViewOptions["fileList"];
  entries: readonly FileEntry[];
  indent?: number;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  if (layout === "flat") {
    return entries.map((entry) => (
      <FileRow key={entry.file.index} theme={theme} {...entry} indent={indent} />
    ));
  }
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return treeRows(entries, (entry) => entry.file.path, collapsed).map((row) =>
    row.kind === "directory" ? (
      <DirectoryRow
        key={`directory:${row.path}`}
        theme={theme}
        name={row.name}
        collapsed={row.collapsed}
        indent={indent + row.depth * TREE_INDENT}
        onPress={() => toggle(row.path)}
      />
    ) : (
      <FileRow
        key={row.item.file.index}
        theme={theme}
        {...row.item}
        name={row.name}
        indent={indent + row.depth * TREE_INDENT + CHEVRON_SPACE}
      />
    ),
  );
}

function DirectoryRow({
  theme,
  name,
  collapsed,
  indent,
  onPress,
}: {
  theme: PluginTheme;
  name: string;
  collapsed: boolean;
  indent: number;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${name}`}
      accessibilityState={{ expanded: !collapsed }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: 32,
        paddingLeft: 12 + indent,
        paddingRight: 8,
        backgroundColor: pressed ? theme.colors.surface1 : "transparent",
      })}
    >
      <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
      <Text style={{ flex: 1, fontSize: 14, color: theme.colors.foregroundMuted }} numberOfLines={1}>
        {name}
      </Text>
    </Pressable>
  );
}

function FileRow({
  theme,
  file,
  name,
  additions,
  deletions,
  viewed,
  comments = 0,
  indent,
  onPress,
}: FileEntry & { theme: PluginTheme; name?: string; indent: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show ${file.path}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: 32,
        paddingLeft: 12 + indent,
        paddingRight: 8,
        backgroundColor: pressed ? theme.colors.surface1 : "transparent",
      })}
    >
      {viewed == null ? null : (
        <View style={{ width: 14 }}>
          {viewed ? <Icon name="Check" size={14} color={theme.colors.statusSuccess} /> : null}
        </View>
      )}
      <FileLabel theme={theme} path={name ?? file.path} />
      {comments === 0 ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Icon name="MessageSquare" size={12} color={theme.colors.foregroundMuted} />
          <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>{comments}</Text>
        </View>
      )}
      <ChangeStats theme={theme} file={file} additions={additions} deletions={deletions} />
    </Pressable>
  );
}
