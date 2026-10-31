import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { SCROLL_PERSIST_MS, type ScrollAnchor, useDebouncedCallback } from "./scroll-anchor";

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
  const restored = useRef(false);
  useEffect(() => {
    restored.current = false;
  }, [narrow]);
  const persist = useDebouncedCallback(onScroll, SCROLL_PERSIST_MS);
  const restoreIndex = narrow && scroll != null ? blocks.findIndex((block) => block.file.path === scroll.path) : -1;
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
      listKey={narrow ? "narrow" : "wide"}
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
      {...(narrow
        ? {
            restore: restoreIndex >= 0 ? restoreIndex : undefined,
            restoreReady: stateLoaded,
            onRestored: () => {
              restored.current = true;
            },
            onTopBlock: (blockIndex: number) => {
              if (restored.current) persist({ path: blocks[blockIndex].file.path });
            },
          }
        : {})}
    />
  );
}
