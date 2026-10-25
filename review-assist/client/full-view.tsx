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

export function FullView({
  theme,
  narrow,
  view,
  onResizePane,
  fold,
  diff,
  source,
  comments,
}: {
  theme: PluginTheme;
  narrow: boolean;
  view: ViewOptions;
  onResizePane(width: number): void;
  fold: FoldCommand | null;
  diff: ParsedDiff;
  source: CodeSource;
  comments: CommentStore;
}) {
  const blocks = useMemo(() => {
    const all = fullBlocks(diff);
    return view.fileList === "tree" ? treeOrder(all, (block) => block.file.path) : all;
  }, [diff, view.fileList]);
  const [target, setTarget] = useState<ScrollTarget | null>(null);
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
      view={view}
      onResizePane={onResizePane}
      paneHeading={`${blocks.length} ${blocks.length === 1 ? "file" : "files"} changed`}
      pane={
        narrow ? null : (
          <FileList
            theme={theme}
            layout={view.fileList}
            entries={blocks.map(({ file }, blockIndex) => ({
              file,
              additions: file.additions,
              deletions: file.deletions,
              comments: counts.get(file.path),
              onPress: () => setTarget({ blockIndex, nonce: Date.now() }),
            }))}
          />
        )
      }
      blocks={blocks}
      source={source}
      target={target}
      fold={fold}
      comments={comments}
    />
  );
}
