import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, memo, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { CommentTarget } from "../shared/comments";
import { type DiffFile, type DiffLine, isChange } from "../shared/diff";
import { type FileBlock, blockCounts } from "../shared/guide";
import type { DraftComment } from "../shared/protocol";
import type { ViewOptions } from "../shared/settings";
import { type SideLine, blockHunks, changesThrough, shownChangeCount } from "../shared/sides";
import type { CommentDraft, FileComments, Suggestion } from "./comments";
import { BinaryBody, LfsBody } from "./binary-view";
import { ChangeStats, FileLabel, Tabs } from "./controls";
import { type DiffStyles, FILE_HEADER_HEIGHT } from "./diff-styles";
import { MarkdownBody } from "./markdown-view";
import { MermaidBody } from "./mermaid-view";
import { MonacoFileDiff, estimateHeight } from "./monaco-diff";
import type { CodeSource } from "./monaco/review-monaco";
import type { SyntaxPalette } from "./monaco/theme";
import { NativeBody } from "./native-diff";
import { useFileText } from "./use-code";
import type { VisualView } from "./visual-view";
import { ContentTop } from "./windowed-rows";

const VISUAL_TABS = [
  { value: "visual", label: "Visual" },
  { value: "text", label: "Text" },
] as const;

export interface CommentActions {
  compose(filePath: string, blockKey: string, lines: readonly SideLine[], start: number, end: number, extend: boolean): void;
  edit(comment: DraftComment): void;
  cancel(): void;
  submit(target: CommentTarget, body: string, suggestion: Suggestion | null): void;
  remove(id: string): void;
}

interface FileBlockViewProps {
  readonly block: FileBlock;
  readonly foldKey: string;
  readonly source: CodeSource;
  readonly overflowHost: object | null;
  readonly collapsed: boolean;
  readonly changeLimit: number;
  readonly onShowMore: (foldKey: string, shown: number) => void;
  /** Null for files without a rendered diff. */
  readonly visual: VisualView | null;
  readonly onVisual: (foldKey: string, visual: VisualView) => void;
  /** Null hides the checkbox. */
  readonly viewed: boolean | null;
  readonly comments: readonly DraftComment[];
  readonly draft: CommentDraft | null;
  readonly actions: CommentActions;
  readonly onCollapse: (foldKey: string, collapsed: boolean) => void;
  readonly onViewed: (block: FileBlock, foldKey: string, viewed: boolean) => void;
  readonly view: ViewOptions;
  readonly styles: DiffStyles;
  readonly theme: PluginTheme;
  readonly palette: SyntaxPalette | null;
}

export const FileBlockView = memo(function FileBlockView({
  block,
  foldKey,
  source,
  overflowHost,
  collapsed,
  changeLimit,
  onShowMore,
  visual,
  onVisual,
  viewed,
  comments,
  draft,
  actions,
  onCollapse,
  onViewed,
  view,
  styles,
  theme,
  palette,
}: FileBlockViewProps) {
  const { file } = block;
  const top = useContext(ContentTop);
  const [lead, setLead] = useState(FILE_HEADER_HEIGHT);
  const moved = file.oldPath != null && file.oldPath !== file.path;
  const hasText = file.hunks.length > 0 && !file.binary && !file.lfs;
  const monaco = hasText && overflowHost != null && palette != null;
  const text = useFileText(source, file, (hasText || visual?.visual === true) && !collapsed);
  // New hunks laid over the file's previous text misplace lines: keep the last pair that agrees.
  const lastMatched = useRef<{ block: FileBlock; text: string } | null>(null);
  if (text.status === "ready" && !text.previous) lastMatched.current = { block, text: text.text };
  const matched = text.status !== "ready" ? null : text.previous ? lastMatched.current : { block, text: text.text };
  const fileComments = useMemo(
    (): FileComments => ({
      comments,
      draft,
      compose: (lines, start, end, extend = false) => actions.compose(file.path, foldKey, lines, start, end, extend),
      edit: actions.edit,
      cancel: actions.cancel,
      submit: actions.submit,
      remove: actions.remove,
    }),
    [comments, draft, actions, file.path, foldKey],
  );
  const onlyWhitespace = useMemo(
    () =>
      !collapsed &&
      view.hideWhitespace &&
      block.chunks.some(({ hunk, start, end }) => hunk.lines.slice(start, end).some(isChange)) &&
      blockHunks(block, true).hunks.length === 0,
    [block, view.hideWhitespace, collapsed],
  );
  const commentReach = useMemo(
    () => (collapsed || comments.length === 0 ? 0 : changesThrough(block, view.hideWhitespace, onCommentedLine(comments))),
    [block, view.hideWhitespace, collapsed, comments],
  );
  const limit = Math.max(changeLimit, commentReach);
  const shownChanges = useMemo(
    () => (collapsed ? 0 : shownChangeCount(block, view.hideWhitespace)),
    [block, view.hideWhitespace, collapsed],
  );
  const hidden = Math.max(0, shownChanges - limit);
  const showMore = useCallback(() => onShowMore(foldKey, limit), [onShowMore, foldKey, limit]);
  const nativeBody = (
    <NativeBody
      block={block}
      source={source}
      view={view}
      styles={styles}
      theme={theme}
      palette={palette}
      comments={fileComments}
      changeLimit={limit}
      onShowMore={showMore}
      hidden={hidden}
      text={matched?.block === block ? matched.text : null}
    />
  );

  return (
    <View>
      <View onLayout={(event) => setLead(event.nativeEvent.layout.height)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${file.path}`}
          accessibilityState={{ expanded: !collapsed }}
          style={({ pressed }) => [styles.fileHeader, pressed && styles.fileHeaderPressed]}
          onPress={() => onCollapse(foldKey, !collapsed)}
        >
          <FileLabel theme={theme} path={file.path} detail={moved ? `from ${file.oldPath}` : undefined} />
          {comments.length === 0 ? null : (
            <View style={styles.commentCount} accessibilityLabel={`${comments.length} unsent ${comments.length === 1 ? "comment" : "comments"}`}>
              <Icon name="MessageSquare" size={12} color={theme.colors.foregroundMuted} />
              <Text style={styles.viewedLabel}>{comments.length}</Text>
            </View>
          )}
          {visual == null ? null : (
            <Tabs
              theme={theme}
              compact
              value={visual.visual ? "visual" : "text"}
              options={VISUAL_TABS}
              onChange={(value) => onVisual(foldKey, { ...visual, visual: value === "visual" })}
            />
          )}
          <ChangeStats theme={theme} file={file} {...blockCounts(block)} />
          {viewed == null ? null : (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={`Viewed ${file.path}`}
              aria-checked={viewed}
              hitSlop={6}
              onPress={() => onViewed(block, foldKey, !viewed)}
              style={({ pressed }) => [styles.viewedToggle, pressed && styles.fileHeaderPressed]}
            >
              <Icon
                name={viewed ? "SquareCheck" : "Square"}
                size={14}
                color={viewed ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
              />
              <Text style={styles.viewedLabel}>Viewed</Text>
            </Pressable>
          )}
        </Pressable>
        {collapsed
          ? null
          : fileNotes(file).map((note) => (
              <Text key={note} style={styles.note}>
                {note}
              </Text>
            ))}
      </View>
      {collapsed ? null : (
        <View style={styles.body}>
          <ContentTop.Provider value={top + lead}>{body()}</ContentTop.Provider>
        </View>
      )}
    </View>
  );

  function body(): ReactNode {
    if (visual?.visual !== true) return textBody();
    if (visual.kind === "markdown") {
      return (
        <MarkdownBody
          block={block}
          text={text}
          theme={theme}
          comments={fileComments}
          noteStyle={styles.note}
          fallback={textBody()}
        />
      );
    }
    return (
      <MermaidBody
        block={block}
        text={text}
        theme={theme}
        distance={visual.distance}
        onDistance={(distance) => onVisual(foldKey, { ...visual, distance })}
        noteStyle={styles.note}
        fallback={textBody()}
      />
    );
  }

  function textBody(): ReactNode {
    if (onlyWhitespace) return <Text style={styles.note}>Only whitespace changed.</Text>;
    if (file.binary) return <BinaryBody theme={theme} file={file} source={source} noteStyle={styles.note} />;
    if (file.lfs) return <LfsBody theme={theme} file={file} source={source} noteStyle={styles.note} />;
    if (!monaco || text.status === "failed") return nativeBody;
    if (matched == null) return <View style={{ height: estimateHeight(block) }} />;
    return (
      <MonacoFileDiff
        block={matched.block}
        source={source}
        text={matched.text}
        view={view}
        theme={theme}
        palette={palette}
        overflowHost={overflowHost}
        comments={fileComments}
        changeLimit={limit}
        onShowMore={showMore}
        hidden={hidden}
        fallback={nativeBody}
      />
    );
  }
});

function onCommentedLine(comments: readonly DraftComment[]): (line: DiffLine) => boolean {
  const lines = { old: new Set<number>(), new: new Set<number>() };
  for (const comment of comments) lines[comment.side].add(comment.lineNumber);
  return (line) =>
    (line.oldNumber != null && lines.old.has(line.oldNumber)) || (line.newNumber != null && lines.new.has(line.newNumber));
}

function fileNotes(file: DiffFile): string[] {
  const oldMode = file.header.find((line) => line.startsWith("old mode "))?.slice(9);
  const newMode = file.header.find((line) => line.startsWith("new mode "))?.slice(9);
  const notes: string[] = [];
  if (oldMode != null && newMode != null) notes.push(`Mode changed from ${oldMode} to ${newMode}.`);
  if (file.hunks.length === 0 && !file.binary) {
    if (file.status === "renamed") notes.push("Renamed without content changes.");
    if (file.status === "copied") notes.push("Copied without content changes.");
    if (file.status === "added") notes.push("Empty file added.");
    if (file.status === "deleted") notes.push("Empty file deleted.");
  }
  return notes;
}
