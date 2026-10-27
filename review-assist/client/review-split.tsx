import type { PluginTheme } from "@getpaseo/plugin";
import type { ComponentProps, ReactNode } from "react";
import type { ViewOptions } from "../shared/settings";
import { DiffList } from "./diff-list";
import { PaneHeading, Split } from "./panes";

type ListProps = Omit<ComponentProps<typeof DiffList>, "theme" | "view">;

export function ReviewSplit({
  theme,
  view,
  onResizePane,
  paneHeading,
  pane,
  listKey,
  ...list
}: ListProps & {
  theme: PluginTheme;
  view: ViewOptions;
  onResizePane(width: number): void;
  paneHeading: string;
  pane: ReactNode | null;
  /** Remounts the diff alone, keeping the pane's filter and width. */
  listKey?: string;
}) {
  return (
    <Split
      theme={theme}
      paneWidth={view.paneWidth}
      onResizePane={onResizePane}
      pane={
        pane == null || !view.showPane ? null : (
          <>
            <PaneHeading theme={theme}>{paneHeading}</PaneHeading>
            {pane}
          </>
        )
      }
    >
      <DiffList key={listKey} theme={theme} view={view} {...list} />
    </Split>
  );
}
