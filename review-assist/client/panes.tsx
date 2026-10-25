import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, Text, View } from "react-native";
import type { DiffFile } from "../shared/diff";
import type { ViewOptions } from "../shared/settings";
import { treeRows } from "../shared/tree";
import { ChangeStats, FileLabel } from "./controls";
import { markResizing } from "./web";

const MIN_PANE_WIDTH = 180;
const MAX_PANE_WIDTH = 640;
const MIN_DIFF_WIDTH = 480;
const TREE_INDENT = 12;
const CHEVRON_SPACE = 22;
const RESIZE_HANDLE = { reviewresize: "" } as const;

/** Whether `width` holds the side pane beside a diff still wide enough to read. */
export function fitsPane(width: number): boolean {
  return width >= MIN_PANE_WIDTH + MIN_DIFF_WIDTH;
}

const FileFilter = createContext("");

/** Whether `path` contains every space-separated word of the side pane's filter, ignoring case; null without one. */
function useFileFilter(): ((path: string) => boolean) | null {
  const words = useContext(FileFilter).toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return (path) => words.every((word) => path.toLowerCase().includes(word));
}

/** Hides `children` while the side pane's filter matches none of `paths`. */
export function Filtered({ paths, children }: { paths: readonly string[]; children: ReactNode }) {
  const matches = useFileFilter();
  return matches == null || paths.some(matches) ? children : null;
}

/** A null `pane` leaves the diff alone, without remounting it. */
export function Split({
  theme,
  paneWidth,
  onResizePane,
  pane,
  children,
}: {
  theme: PluginTheme;
  paneWidth: number;
  onResizePane(width: number): void;
  pane: ReactNode | null;
  children: ReactNode;
}) {
  const [dragged, setDragged] = useState<number | null>(null);
  const [room, setRoom] = useState(Infinity);
  const [filter, setFilter] = useState("");
  // The handle unmounts with the pane, so a drag it was holding never drops.
  if (pane == null && dragged != null) setDragged(null);
  const clamp = (width: number) => clampPane(width, room);
  const width = dragged ?? clamp(paneWidth);
  return (
    <View
      style={{ flex: 1, flexDirection: "row" }}
      onLayout={(event) => setRoom(Math.min(MAX_PANE_WIDTH, event.nativeEvent.layout.width - MIN_DIFF_WIDTH))}
    >
      {pane == null ? null : (
        // Above the diff: Monaco's margin otherwise covers half the resize handle.
        <View style={{ width, zIndex: 1, borderRightWidth: 1, borderRightColor: theme.colors.border }}>
          <TextInput
            accessibilityLabel="Filter files"
            value={filter}
            onChangeText={setFilter}
            placeholder="Filter files"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              marginHorizontal: 8,
              marginTop: 8,
              paddingHorizontal: 8,
              paddingVertical: 6,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: theme.colors.border,
              color: theme.colors.foreground,
              fontSize: 14,
            }}
          />
          <FileFilter.Provider value={filter}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
              {pane}
            </ScrollView>
          </FileFilter.Provider>
          <ResizeHandle
            theme={theme}
            width={width}
            clamp={clamp}
            onDrag={setDragged}
            onDrop={(next) => {
              setDragged(null);
              onResizePane(next);
            }}
          />
        </View>
      )}
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

function ResizeHandle({
  theme,
  width,
  clamp,
  onDrag,
  onDrop,
}: {
  theme: PluginTheme;
  width: number;
  clamp(width: number): number;
  onDrag(width: number): void;
  onDrop(width: number): void;
}) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    markResizing(true);
    return () => markResizing(false);
  }, [dragging]);
  const start = useRef(width);
  const latest = useRef({ width, clamp, onDrag, onDrop });
  latest.current = { width, clamp, onDrag, onDrop };
  const responder = useMemo(() => {
    const finish = (dx: number) => {
      setDragging(false);
      latest.current.onDrop(latest.current.clamp(start.current + dx));
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        start.current = latest.current.width;
        setDragging(true);
      },
      onPanResponderMove: (_, { dx }) => latest.current.onDrag(latest.current.clamp(start.current + dx)),
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

function clampPane(width: number, room: number): number {
  return Math.round(Math.max(MIN_PANE_WIDTH, Math.min(MAX_PANE_WIDTH, room, width)));
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
  const matches = useFileFilter();
  const shown = matches == null ? entries : entries.filter((entry) => matches(entry.file.path));
  if (layout === "flat") {
    return shown.map((entry) => (
      <FileRow key={entry.file.index} theme={theme} {...entry} indent={indent} />
    ));
  }
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return treeRows(shown, (entry) => entry.file.path, collapsed).map((row) =>
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
