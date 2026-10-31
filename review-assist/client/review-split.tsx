import type { PluginTheme } from "@getpaseo/plugin";
import type { ComponentProps, ReactNode } from "react";
import type { ViewOptions } from "../shared/settings";
import { DiffList } from "./diff-list";
import { PaneHeading, Split } from "./panes";

type ListProps = Omit<ComponentProps<typeof DiffList>, "theme" | "view">;

export function ReviewSplit({
  theme,
  narrow,
  paneShown,
  onCloseDrawer,
  view,
  onResizePane,
  paneHeading,
  pane,
  listKey,
  ...list
}: ListProps & {
  theme: PluginTheme;
  /** Too narrow to hold the pane beside the diff: it opens over the diff as a drawer. */
  narrow: boolean;
  paneShown: boolean;
  onCloseDrawer(): void;
  view: ViewOptions;
  onResizePane(width: number): void;
  paneHeading: string;
  pane: ReactNode;
  /** Remounts the diff alone, keeping the pane's filter and width. */
  listKey?: string;
}) {
  return (
    <Split
      theme={theme}
      paneWidth={view.paneWidth}
      onResizePane={onResizePane}
      onDismiss={narrow ? onCloseDrawer : undefined}
      pane={
        paneShown ? (
          <>
            <PaneHeading theme={theme}>{paneHeading}</PaneHeading>
            {pane}
          </>
        ) : null
      }
    >
      <DiffList key={listKey} theme={theme} view={view} {...list} />
    </Split>
  );
}
