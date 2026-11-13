import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { ParsedDiff } from "../shared/diff";
import { fullBlocks } from "../shared/guide";
import type { ViewOptions } from "../shared/settings";
import { treeOrder } from "../shared/tree";
import { countByPath } from "./comments";
import type { CommentStore, FoldCommand, ScrollTarget } from "./diff-list";
import type { CodeSource } from "./monaco/review-monaco";
import { FileList } from "./panes";
import { ReviewSplit } from "./review-split";
import { SCROLL_PERSIST_MS, type ScrollAnchor, useDebouncedCallback, useRestoreGate } from "./scroll-anchor";

export function FullView({
  theme,
  narrow,
  paneShown,
  onCloseDrawer,
  view,
  onResizePane,
  fold,
  diff,
  source,
  scroll,
  onScroll,
  stateLoaded,
  comments,
}: {
  theme: PluginTheme;
  narrow: boolean;
  paneShown: boolean;
  onCloseDrawer(): void;
  view: ViewOptions;
  onResizePane(width: number): void;
  fold: FoldCommand | null;
  diff: ParsedDiff;
  source: CodeSource;
  scroll?: ScrollAnchor;
  onScroll(anchor: ScrollAnchor): void;
  stateLoaded: boolean;
  comments: CommentStore;
}) {
  const blocks = useMemo(() => {
    const all = fullBlocks(diff);
    return view.fileList === "tree" ? treeOrder(all, (block) => block.file.path) : all;
  }, [diff, view.fileList]);
  const [target, setTarget] = useState<ScrollTarget | null>(null);
  const listKey = narrow ? "narrow" : "wide";
  const gate = useRestoreGate(listKey);
  const persist = useDebouncedCallback(onScroll, SCROLL_PERSIST_MS, listKey);
  const restoreIndex = scroll == null ? -1 : blocks.findIndex((block) => block.file.path === scroll.path);
  const counts = countByPath(comments.comments);

  if (blocks.length === 0) {
    return (
      <View style={{ flex: 1, padding: 24 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>No changes.</Text>
      </View>
    );
  }
  return (
    <ReviewSplit
      theme={theme}
      narrow={narrow}
      paneShown={paneShown}
      onCloseDrawer={onCloseDrawer}
      view={view}
      onResizePane={onResizePane}
      listKey={listKey}
      paneHeading={`${blocks.length} ${blocks.length === 1 ? "file" : "files"} changed`}
      pane={
        <FileList
          theme={theme}
          layout={view.fileList}
          entries={blocks.map(({ file }, blockIndex) => ({
            file,
            additions: file.additions,
            deletions: file.deletions,
            comments: counts.get(file.path),
            onPress: () => {
              setTarget({ blockIndex, nonce: Date.now() });
              onCloseDrawer();
            },
          }))}
        />
      }
      blocks={blocks}
      source={source}
      target={target}
      fold={fold}
      comments={comments}
      restore={restoreIndex < 0 ? undefined : { block: restoreIndex, within: scroll?.within ?? 0 }}
      restoreReady={stateLoaded}
      onRestored={gate.markRestored}
      onTopBlock={(blockIndex, within) => {
        if (gate.hasRestored()) persist({ path: blocks[blockIndex].file.path, within });
      }}
    />
  );
}
