import type { PluginClientContext } from "@getpaseo/plugin/client";
import { UpdateSettings } from "../kit/client/update-settings";
import { MarkdownReviewPanel } from "./panel";

export default function contribute(client: PluginClientContext): () => void {
  const panel = client.addFilePanel({
    id: "markdown-review",
    title: "Markdown review",
    icon: "MessageSquare",
    files: { extensions: ["md", "markdown"] },
    Component: MarkdownReviewPanel,
  });
  const settings = client.addSettingsScreen({
    id: "markdown-review",
    title: "Settings",
    icon: "MessageSquare",
    Component: UpdateSettings,
  });
  return () => {
    panel();
    settings();
  };
}
