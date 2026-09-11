import type { PluginClientContext } from "@getpaseo/plugin/client";
import { EditorPanel } from "./client/panel";
import { EditorSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "editor",
    title: "Editor",
    icon: "FileCode",
    Component: EditorSettingsScreen,
  });

  client.addWorkspacePanel({
    id: "editor",
    title: "Editor",
    icon: "FileCode",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: EditorPanel,
  });

  client.addCommandCenterItem({
    id: "open-editor",
    title: "Open editor",
    icon: "FileCode",
    keywords: ["vscode", "code", "file"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("editor");
    },
  });

  return () => {};
}
