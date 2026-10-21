import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ParsedDiff } from "../shared/diff";
import { type FileBlock, blockCounts, blockFingerprint, guideBlocks } from "../shared/guide";
import type { GuideRecord } from "../shared/protocol";
import type { ViewOptions } from "../shared/settings";
import { treeOrder } from "../shared/tree";
import { countByPath } from "./comments";
import { Button, Notice } from "./controls";
import { DiffList, type FileViewing, type FoldCommand, type ScrollTarget } from "./diff-list";
import { FileList, PaneHeading, Split } from "./panes";
import { type Review, commentStore } from "./use-review";

interface GuidedViewProps {
  readonly theme: PluginTheme;
  /** Too narrow for the side pane: every section in one scroll instead. */
  readonly narrow: boolean;
  readonly view: ViewOptions;
  readonly onResizePane: (width: number) => void;
  readonly fold: FoldCommand | null;
  readonly review: Review;
  readonly openAgent?: (agentId: string) => void;
}

export function GuidedView({ theme, narrow, view, onResizePane, fold, review, openAgent }: GuidedViewProps) {
  const { guide, live } = review;
  if (guide == null) {
    return <Message theme={theme}>{review.guideError ?? "Loading the guided review…"}</Message>;
  }
  const { job, record, diff } = guide;
  const agentButton = (agentId: string | null) =>
    agentId == null || openAgent == null ? null : (
      <Button theme={theme} size="xs" label="Open agent" icon="Bot" onPress={() => openAgent(agentId)} />
    );
  const stale = record != null && live.status === "ready" && live.hash !== record.diffHash;

  const notices = (
    <>
      {job?.status === "running" ? (
        <Notice theme={theme} tone="progress" actions={agentButton(job.agentId)}>
          Analysing changes…
        </Notice>
      ) : null}
      {job?.status === "failed" ? (
        <Notice
          theme={theme}
          tone="danger"
          actions={
            <>
              {agentButton(job.agentId)}
              <Button theme={theme} size="xs" label="Try again" icon="RefreshCw" onPress={review.generate} />
            </>
          }
        >
          {job.error}
        </Notice>
      ) : null}
      {stale && job?.status !== "running" ? (
        <Notice
          theme={theme}
          tone="warning"
          actions={
            <Button theme={theme} size="xs" label="Regenerate" icon="RefreshCw" onPress={review.generate} />
          }
        >
          The diff changed after this review was generated. The sections still show the diff they were made from.
        </Notice>
      ) : null}
    </>
  );

  if (record == null || diff == null) {
    const empty = live.status === "ready" && live.diff.files.length === 0;
    return (
      <View style={{ flex: 1 }}>
        {notices}
        {job == null ? (
          <View style={{ padding: narrow ? 16 : 24, gap: 12, maxWidth: 560 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>
              Guided review
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 }}>
              An agent splits the diff into sections by intent and layer, ordered so each builds on the last.
              It only picks line ranges, so every line you review is the real diff, and the sections add up to
              exactly the full diff.
            </Text>
            <View style={{ flexDirection: "row" }}>
              <Button
                theme={theme}
                variant="default"
                label={empty ? "No changes to review" : "Generate guided review"}
                icon="Sparkles"
                disabled={live.status !== "ready" || empty}
                onPress={review.generate}
              />
            </View>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {notices}
      <Sections
        theme={theme}
        narrow={narrow}
        view={view}
        onResizePane={onResizePane}
        fold={fold}
        record={record}
        diff={diff}
        review={review}
      />
    </View>
  );
}

function Sections({
  theme,
  narrow,
  view,
  onResizePane,
  fold,
  record,
  diff,
  review,
}: {
  theme: PluginTheme;
  narrow: boolean;
  view: ViewOptions;
  onResizePane(width: number): void;
  fold: FoldCommand | null;
  record: GuideRecord;
  diff: ParsedDiff;
  review: Review;
}) {
  const [selected, setSelected] = useState(0);
  const [target, setTarget] = useState<ScrollTarget | null>(null);
  const blocksBySection = useMemo(() => {
    const sections = guideBlocks(diff, record.sections);
    return view.fileList === "tree"
      ? sections.map((blocks) => treeOrder(blocks, (block) => block.file.path))
      : sections;
  }, [record.sections, diff, view.fileList]);
  const allBlocks = useMemo(() => blocksBySection.flat(), [blocksBySection]);
  const sectionStarts = useMemo(() => {
    const starts = new Map<number, number>();
    let offset = 0;
    blocksBySection.forEach((blocks, sectionIndex) => {
      if (blocks.length > 0) starts.set(offset, sectionIndex);
      offset += blocks.length;
    });
    return starts;
  }, [blocksBySection]);
  const fingerprints = useMemo(
    () => new Map(allBlocks.map((block) => [block, blockFingerprint(block)])),
    [allBlocks],
  );
  const marks = useMemo(
    () => new Set(review.state.viewed.map(({ path, fingerprint }) => `${path}\0${fingerprint}`)),
    [review.state.viewed],
  );
  const source = useMemo(
    () => ({ root: record.root, tree: record.tree, base: record.base.sha }),
    [record.root, record.tree, record.base.sha],
  );
  const isViewed = (block: FileBlock) => marks.has(`${block.file.path}\0${fingerprints.get(block)}`);
  const sectionViewed = blocksBySection.map((files) => files.every(isViewed));
  const count = record.sections.length;
  const index = Math.min(selected, count - 1);
  const section = record.sections[index];
  const blocks = blocksBySection[index];
  const hasNext = index < count - 1;
  const viewed: FileViewing = {
    isViewed,
    setViewed: (block, value) =>
      review.setViewed({ path: block.file.path, fingerprint: fingerprints.get(block) ?? blockFingerprint(block) }, value),
  };
  const comments = commentStore(review);
  const commentCounts = countByPath(review.state.comments);

  const go = (next: number, blockIndex?: number) => {
    setSelected(next);
    setTarget(blockIndex == null ? null : { blockIndex, nonce: Date.now() });
  };

  const inset = narrow ? 12 : 16;
  const headingFor = (sectionIndex: number) => (
    <SectionHeading
      theme={theme}
      inset={inset}
      section={record.sections[sectionIndex]}
      index={sectionIndex}
      count={count}
      files={blocksBySection[sectionIndex].length}
      viewed={sectionViewed[sectionIndex]}
    />
  );

  if (narrow) {
    return (
      <DiffList
        key={record.createdAt}
        blocks={allBlocks}
        source={source}
        theme={theme}
        view={view}
        target={null}
        fold={fold}
        viewed={viewed}
        comments={comments}
        heading={(blockIndex) => {
          const sectionIndex = sectionStarts.get(blockIndex);
          return sectionIndex == null ? null : headingFor(sectionIndex);
        }}
      />
    );
  }

  const header = headingFor(index);
  const footer = (
    <View
      style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8, padding: inset }}
    >
      <Button
        theme={theme}
        label="Previous"
        icon="ChevronLeft"
        disabled={index === 0}
        onPress={() => go(index - 1)}
      />
      <Button theme={theme} label="Next" icon="ChevronRight" disabled={!hasNext} onPress={() => go(index + 1)} />
    </View>
  );

  return (
    <Split
      theme={theme}
      paneWidth={view.paneWidth}
      onResizePane={onResizePane}
      pane={
        <>
          <PaneHeading theme={theme}>
            {sectionViewed.filter(Boolean).length} of {count} sections viewed
          </PaneHeading>
          {record.sections.map((item, sectionIndex) => (
            <View key={item.id} style={{ paddingBottom: 6 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: sectionIndex === index }}
                onPress={() => go(sectionIndex)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  backgroundColor:
                    sectionIndex === index ? theme.colors.surface2 : pressed ? theme.colors.surface1 : "transparent",
                })}
              >
                <View style={{ paddingTop: 3 }}>
                  <Icon
                    name={sectionViewed[sectionIndex] ? "CircleCheck" : "Circle"}
                    size={14}
                    color={sectionViewed[sectionIndex] ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
                  />
                </View>
                <Text
                  style={{ flex: 1, fontSize: 14, lineHeight: 20, color: theme.colors.foreground, fontWeight: "600" }}
                  numberOfLines={2}
                >
                  {sectionIndex + 1}. {item.title}
                </Text>
              </Pressable>
              <FileList
                theme={theme}
                layout={view.fileList}
                indent={22}
                entries={blocksBySection[sectionIndex].map((block, blockIndex) => ({
                  file: block.file,
                  ...blockCounts(block),
                  viewed: isViewed(block),
                  comments: commentCounts.get(block.file.path),
                  onPress: () => go(sectionIndex, blockIndex),
                }))}
              />
            </View>
          ))}
        </>
      }
    >
      <DiffList
        key={`${record.createdAt}:${section.id}`}
        blocks={blocks}
        source={source}
        theme={theme}
        view={view}
        target={target}
        fold={fold}
        viewed={viewed}
        comments={comments}
        header={header}
        footer={footer}
      />
    </Split>
  );
}

function SectionHeading({
  theme,
  inset,
  section,
  index,
  count,
  files,
  viewed,
}: {
  theme: PluginTheme;
  inset: number;
  section: GuideRecord["sections"][number];
  index: number;
  count: number;
  files: number;
  viewed: boolean;
}) {
  return (
    <View style={{ gap: 6, padding: inset, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Section {index + 1} of {count} · {files} {files === 1 ? "file" : "files"}
        {viewed ? " · Viewed" : ""}
      </Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>
        {section.title}
      </Text>
      {section.description === "" ? null : (
        <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>{section.description}</Text>
      )}
    </View>
  );
}

function Message({ theme, children }: { theme: PluginTheme; children: string }) {
  return (
    <View style={{ flex: 1, padding: 24 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{children}</Text>
    </View>
  );
}
