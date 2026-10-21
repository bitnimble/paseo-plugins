import type { PluginClientContext } from "@getpaseo/plugin/client";
import { reviewMonaco } from "./client/monaco/review-monaco";
import { ReviewPanel } from "./client/panel";
import { ReviewSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext): () => void {
  client.addWorkspacePanel({
    id: "review",
    title: "Review",
    icon: "ListChecks",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ReviewPanel,
  });
  client.addCommandCenterItem({
    id: "open-review",
    title: "Open guided review",
    icon: "ListChecks",
    keywords: ["diff", "changes", "review", "guided"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("review");
    },
  });
  client.addSettingsScreen({
    id: "review",
    title: "Settings",
    icon: "ListChecks",
    Component: ReviewSettingsScreen,
  });
  return () => reviewMonaco.dispose();
}
