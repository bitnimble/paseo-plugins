import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { leaseRpc, lspRpc, readFileRpc, syncRpc, writeFileRpc } from "../shared/protocol";
import { EditorController, type EditorBridge } from "./editor";
import { FilePicker } from "./picker";
import { editorTabs, useEditorTabs } from "./tabs";
import { asEditorContainer, isEditorSupported } from "./web";

const LEASE_REFRESH_MS = 30_000;

export function EditorPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const tabs = useEditorTabs(workspaceId);
  const toast = useToast();

  const lease = useRpc(leaseRpc);
  const readFile = useRpc(readFileRpc);
  const writeFile = useRpc(writeFileRpc);
  const lsp = useRpc(lspRpc);
  const sync = useRpc(syncRpc);

  const calls = useRef({ lease, readFile, writeFile, lsp, sync, toast, theme });
  calls.current = { lease, readFile, writeFile, lsp, sync, toast, theme };

  const [container, setContainer] = useState<object | null>(null);
  const [controller, setController] = useState<EditorController | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const bridge = useMemo<EditorBridge>(
    () => ({
      readFile: async (path) => (await calls.current.readFile({ workspaceId, path })).text,
      writeFile: async (path, text) => {
        await calls.current.writeFile({ workspaceId, path, text });
        calls.current.toast.show("Saved", { variant: "success" });
      },
      request: async (path, method, params) => {
        const response = await calls.current.lsp({ workspaceId, path, method, params });
        if (response.status === "failed") {
          throw new Error(response.error);
        }
        return response.status === "ok" ? response.result : null;
      },
      sync: (path, kind, text) => void calls.current.sync({ workspaceId, path, kind, text }),
      openPath: (path) => editorTabs.open(workspaceId, path),
      reportError: (message) => calls.current.toast.error(message),
    }),
    [workspaceId],
  );

  useEffect(() => {
    const leaseId = `${workspaceId}:${Math.random().toString(36).slice(2)}`;
    const hold = () => void calls.current.lease({ workspaceId, leaseId, action: "hold" });
    hold();
    const refresh = setInterval(hold, LEASE_REFRESH_MS);
    return () => {
      clearInterval(refresh);
      void calls.current.lease({ workspaceId, leaseId, action: "release" });
    };
  }, [workspaceId]);

  useEffect(() => {
    if (container == null || directory == null) {
      return;
    }
    let created: EditorController | null = null;
    let live = true;
    void EditorController.create(asEditorContainer(container), directory, bridge, calls.current.theme)
      .then((editor) => {
        created = editor;
        if (live) {
          setController(editor);
          setFailure(null);
        } else {
          editor.dispose();
        }
      })
      .catch((error: unknown) => {
        if (live) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      live = false;
      created?.dispose();
      setController(null);
    };
  }, [container, directory, bridge]);

  useEffect(() => {
    controller?.setTheme(theme);
  }, [controller, theme]);

  useEffect(() => {
    if (controller == null || tabs.activePath == null) {
      return;
    }
    controller.show(tabs.activePath).catch((error: unknown) => {
      calls.current.toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [controller, tabs.activePath]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      bar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        paddingHorizontal: 8,
        paddingVertical: layout.compact ? 4 : 6,
      },
      message: { color: theme.colors.foregroundMuted, padding: 24 },
    }),
    [theme, layout.compact],
  );

  if (!isEditorSupported()) {
    return (
      <View style={styles.screen}>
        <Text style={styles.message}>The editor runs only in the Paseo web and desktop apps.</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <ScrollView horizontal style={{ flexGrow: 1 }} showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {tabs.paths.map((path) => (
              <FileTab
                key={path}
                path={path}
                active={path === tabs.activePath}
                theme={theme}
                onPress={() => editorTabs.activate(workspaceId, path)}
                onClose={() => {
                  controller?.closed(path);
                  editorTabs.close(workspaceId, path);
                }}
              />
            ))}
          </View>
        </ScrollView>
        <Pressable accessibilityRole="button" onPress={() => setPickerOpen(true)} style={{ padding: 6 }}>
          <Icon name="Plus" size={16} color={theme.colors.foreground} />
        </Pressable>
      </View>

      {failure == null ? null : <Text style={styles.message}>{failure}</Text>}
      {tabs.activePath == null && failure == null ? (
        <Text style={styles.message}>Open a file to start editing.</Text>
      ) : null}

      <View style={{ flex: 1 }} ref={setContainer} />

      <FilePicker
        workspaceId={workspaceId}
        theme={theme}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(path) => editorTabs.open(workspaceId, path)}
      />
    </View>
  );
}

function FileTab({
  path,
  active,
  theme,
  onPress,
  onClose,
}: {
  path: string;
  active: boolean;
  theme: PluginTheme;
  onPress(): void;
  onClose(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: active ? theme.colors.surface2 : "transparent",
      }}
    >
      <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted }}>
        {path.slice(path.lastIndexOf("/") + 1)}
      </Text>
      <Pressable accessibilityRole="button" onPress={onClose}>
        <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
      </Pressable>
    </Pressable>
  );
}
