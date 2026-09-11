import type { PluginClientContext } from "@getpaseo/plugin/client";
import { disposeProviders } from "./client/editor";
import { EditorPanel } from "./client/panel";
import { editorTabs } from "./client/tabs";

export default function contribute(client: PluginClientContext) {
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
    keywords: ["monaco", "code", "file"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("editor");
    },
  });

  client.addSlashCommand({
    name: "edit",
    description: "Open a workspace file in the Monaco editor",
    argumentHint: "<path>",
    context: "workspace",
    onSubmit({ args, workspace, openPanel }) {
      const path = args.trim();
      if (path.length > 0) {
        editorTabs.open(workspace.id, path);
      }
      openPanel("editor");
    },
  });

  return disposeProviders;
}
