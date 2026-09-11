import {
  type PluginWorkspacePanelProps,
  useRpc,
  useSettings,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { sessionRpc } from "../shared/protocol";
import { editorSettings } from "../shared/settings";
import { asEditorContainer, isEditorSupported, mountEditorFrame } from "./web";

const LEASE_REFRESH_MS = 30_000;

export function EditorPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const session = useRpc(sessionRpc);
  const settings = useSettings(editorSettings);
  const values = settings.status === "ready" ? settings.values : null;

  const [container, setContainer] = useState<object | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const calls = useRef({ session, values });
  calls.current = { session, values };

  useEffect(() => {
    if (calls.current.values == null) {
      return;
    }
    const leaseId = `${workspaceId}:${Math.random().toString(36).slice(2)}`;
    let live = true;

    const hold = async () => {
      const result = await calls.current.session({
        workspaceId,
        leaseId,
        action: "hold",
        settings: calls.current.values ?? undefined,
      });
      if (!live || result.status === "released") {
        return;
      }
      if (result.status === "failed") {
        setFailure(result.error);
        return;
      }
      setFailure(null);
      setUrl(result.url);
    };

    void hold();
    const refresh = setInterval(() => void hold(), LEASE_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(refresh);
      void calls.current.session({ workspaceId, leaseId, action: "release" });
    };
  }, [workspaceId, values != null]);

  useEffect(() => {
    if (container == null || url == null) {
      return;
    }
    return mountEditorFrame(asEditorContainer(container), url);
  }, [container, url]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      message: { color: theme.colors.foregroundMuted, padding: layout.compact ? 16 : 24 },
      error: { color: theme.colors.statusDanger, padding: layout.compact ? 16 : 24 },
    }),
    [theme, layout.compact],
  );

  if (!isEditorSupported()) {
    return (
      <View style={styles.screen}>
        <Text style={styles.message}>
          The editor runs only in the Paseo web and desktop apps: a plugin cannot reach a web view on
          iOS or Android.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {failure == null ? null : <Text style={styles.error}>{failure}</Text>}
      {url == null && failure == null ? (
        <Text style={styles.message}>
          {directory == null ? "Waiting for the workspace…" : `Starting the editor in ${directory}…`}
        </Text>
      ) : null}
      <View style={{ flex: 1 }} ref={setContainer} />
    </View>
  );
}
