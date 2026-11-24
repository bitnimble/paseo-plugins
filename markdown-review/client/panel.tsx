import { type PluginFilePanelProps, useFileText, useRpc } from "@getpaseo/plugin/client";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { type ScrollView as NativeScrollView, Text, View } from "react-native";
import { FileLabel } from "../kit/client/controls";
import { ErrorBoundary } from "../kit/client/error-boundary";
import type { FileText } from "../kit/client/file-text";
import { CentreAboveKeyboard, type Scroller, useCentreAboveKeyboard } from "../kit/client/keyboard";
import { MarkdownBody } from "../kit/client/markdown-view";
import { Toolbar } from "../kit/client/menu";
import { SendComments } from "../kit/client/send-comments";
import { fileComments, useCommentDrafts } from "../kit/client/use-comment-drafts";
import { useReviewState } from "../kit/client/use-review-state";
import { ScrollLock } from "../kit/client/zoomable-image";
import type { FileBlock } from "../kit/shared/blocks";
import { messageOf } from "../kit/shared/errors";
import { UNCOMMITTED_MODE } from "../kit/shared/protocol";
import { documentRpc } from "../shared/protocol";

export function MarkdownReviewPanel(props: PluginFilePanelProps) {
  return (
    <ErrorBoundary theme={props.theme}>
      <MarkdownReview {...props} />
    </ErrorBoundary>
  );
}

function MarkdownReview({ file, theme, workspaceId }: PluginFilePanelProps) {
  const locate = useRpc(documentRpc);
  const location = useQuery({ queryKey: ["document", file.path], queryFn: () => locate({ path: file.path }) });
  const document = location.data ?? null;
  const fileText = useFileText(file);
  const text = useMemo((): FileText => {
    if (fileText.status === "ready") return { status: "ready", text: fileText.text, previous: false };
    return fileText.status === "error" ? { status: "failed", error: fileText.error.message } : { status: "loading" };
  }, [fileText]);
  const review = useReviewState(document?.root ?? null, UNCOMMITTED_MODE, () => {});
  const path = document?.path ?? file.name;
  const allComments = review.state.comments;
  const comments = useMemo(() => allComments.filter(({ filePath }) => filePath === path), [allComments, path]);
  const { draft, actions } = useCommentDrafts({
    comments,
    save: review.saveComment,
    remove: review.deleteComment,
  });
  const block = useMemo(() => documentBlock(path), [path]);
  const commentsHere = useMemo(
    () => fileComments(path, path, comments, draft, actions),
    [path, comments, draft, actions],
  );
  const frame = useRef<View>(null);
  const scroll = useRef<NativeScrollView>(null);
  const offset = useRef(0);
  const scroller = useRef<Scroller>({
    offset: () => offset.current,
    scrollTo: (y, animated) => scroll.current?.scrollTo({ y, animated }),
  });
  const keyboard = useCentreAboveKeyboard(frame, scroller, draft != null);
  const [scrollLocked, setScrollLocked] = useState(false);
  const note = { color: theme.colors.foregroundMuted, fontSize: 13, padding: 16 };

  if (location.error != null) {
    return <Text style={[note, { color: theme.colors.statusDanger }]}>{messageOf(location.error)}</Text>;
  }
  if (document == null) return <Loading />;
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <Toolbar theme={theme}>
        <FileLabel theme={theme} path={document.path} />
        {comments.length === 0 ? null : (
          <SendComments
            theme={theme}
            workspaceId={workspaceId}
            comments={comments}
            submit={({ reviewer, message }) =>
              review.submit({ baseRef: "", reviewer, message, commentIds: comments.map(({ id }) => id) })
            }
          />
        )}
      </Toolbar>
      <View ref={frame} style={{ flex: 1 }}>
        <ScrollView
          ref={scroll}
          style={{ flex: 1 }}
          scrollEnabled={!scrollLocked}
          onScroll={(event) => {
            offset.current = event.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          contentContainerStyle={{ maxWidth: 900, width: "100%", alignSelf: "center", paddingBottom: keyboard.bottomInset }}
        >
          <ScrollLock.Provider value={setScrollLocked}>
            <CentreAboveKeyboard.Provider value={keyboard.centre}>
              <MarkdownBody
                block={block}
                text={text}
                theme={theme}
                comments={commentsHere}
                view="document"
                noteStyle={note}
                fallback={null}
              />
            </CentreAboveKeyboard.Provider>
          </ScrollLock.Provider>
        </ScrollView>
      </View>
    </View>
  );
}

function documentBlock(path: string): FileBlock {
  return {
    file: {
      index: 0,
      path,
      oldPath: path,
      newPath: path,
      status: "modified",
      oldBlob: null,
      newBlob: null,
      binary: false,
      lfs: false,
      generated: false,
      sizeChange: null,
      header: [],
      hunks: [],
      additions: 0,
      deletions: 0,
    },
    chunks: [],
    later: [],
  };
}
