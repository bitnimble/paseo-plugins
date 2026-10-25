import { type PluginWorkspacePanelProps, useSettings, useWorkspace } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { DEFAULT_BRANCH_MODE, type DiffMode } from "../shared/protocol";
import { type ViewOptions, reviewSettings } from "../shared/settings";
import { IconButton, Tabs } from "./controls";
import type { FoldCommand } from "./diff-list";
import { ErrorBoundary } from "./error-boundary";
import { FullView } from "./full-view";
import { GuidedView } from "./guided-view";
import { Dropdown, MenuBackdrop, MenuHeading, MenuItem, MenuSeparator } from "./menu";
import { ModeMenu } from "./mode-menu";
import { MONOSPACE, compactCount } from "./palette";
import { fitsPane } from "./panes";
import { SendComments } from "./send-comments";
import { TrustDialog, TrustNotice } from "./trust";
import { useCodeIntelligence } from "./use-code";
import { commentStore, useReview } from "./use-review";
import { isMonacoSupported } from "./web";

type Tab = "guided" | "full";
type Menu = "mode" | "view";

const TABS = [
  { value: "guided", label: "Guided" },
  { value: "full", label: "Full diff" },
] as const;

const VIEW_KEYS = ["layout", "wrapLines", "hideWhitespace", "fileList", "paneWidth"] as const;
const DEFAULT_SETTINGS = reviewSettings.schema.parse({});

export function ReviewPanel(props: PluginWorkspacePanelProps) {
  return (
    <ErrorBoundary theme={props.theme}>
      <Review {...props} />
    </ErrorBoundary>
  );
}

function Review({ theme, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ directory, projectId, projectDisplayName, projectKind, diffStat }) => ({
    directory,
    projectId,
    projectDisplayName,
    projectKind,
    additions: diffStat?.additions,
    deletions: diffStat?.deletions,
  }));
  const [mode, setMode] = useState<DiffMode>(DEFAULT_BRANCH_MODE);
  const [tab, setTab] = useState<Tab>("guided");
  const [menu, setMenu] = useState<Menu | null>(null);
  const [fold, setFold] = useState<FoldCommand | null>(null);
  const [fits, setFits] = useState(true);
  const narrow = layout.compact || !fits;
  const { view, setView } = useViewOptions(narrow);
  const review = useReview({
    workspaceId,
    directory: workspace?.directory ?? null,
    projectId: workspace?.projectId ?? null,
    mode,
    revision: `${workspace?.additions}:${workspace?.deletions}`,
  });
  const { live } = review;
  const [trustPrompt, setTrustPrompt] = useState(false);
  const languageFeatures = isMonacoSupported();
  const trusted = review.trust === "trusted";
  useCodeIntelligence(
    languageFeatures && trusted && live.status === "ready" && workspace != null
      ? { projectId: workspace.projectId, root: live.source.root }
      : null,
  );
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };

  if (workspace == null || workspace.projectKind !== "git") {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {workspace == null ? "Waiting for the workspace…" : "Guided review needs a git repository."}
        </Text>
      </View>
    );
  }

  const totals =
    live.status === "ready"
      ? live.diff.files.reduce(
          (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
          { additions: 0, deletions: 0 },
        )
      : null;
  const openMenu = (name: Menu) => (open: boolean) => setMenu(open ? name : null);
  const comments = commentStore(review);
  const resizePane = (paneWidth: number) => setView({ paneWidth });
  const pickMode = (next: DiffMode) => {
    setMode(next);
    setMenu(null);
  };
  const foldAll = (collapsed: boolean) => {
    setFold({ collapsed, nonce: Date.now() });
    setMenu(null);
  };

  return (
    <View
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      onLayout={(event) => setFits(fitsPane(event.nativeEvent.layout.width))}
    >
      {menu == null ? null : <MenuBackdrop onPress={() => setMenu(null)} />}
      <View
        style={{
          zIndex: 10,
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          minHeight: 40,
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
        }}
      >
        <Tabs<Tab> theme={theme} value={tab} options={TABS} onChange={setTab} />
        <ModeMenu
          theme={theme}
          directory={workspace.directory}
          mode={mode}
          base={live.status === "ready" ? live.base : null}
          open={menu === "mode"}
          onOpenChange={openMenu("mode")}
          onPick={pickMode}
        />
        <View style={{ flex: 1 }} />
        {totals == null || live.status !== "ready" ? null : (
          <Text style={muted}>
            <Text style={{ fontFamily: MONOSPACE }}>{live.base.sha.slice(0, 7)}</Text>
            <Text style={{ color: theme.colors.statusSuccess }}> +{compactCount(totals.additions)}</Text>
            <Text style={{ color: theme.colors.statusDanger }}> -{compactCount(totals.deletions)}</Text>
          </Text>
        )}
        {comments.comments.length === 0 ? null : (
          <SendComments theme={theme} workspaceId={workspaceId} comments={comments.comments} submit={review.submit} />
        )}
        <Dropdown
          theme={theme}
          label="View"
          icon="SlidersHorizontal"
          open={menu === "view"}
          onOpenChange={openMenu("view")}
        >
          {narrow ? null : (
            <>
              <MenuHeading theme={theme}>Layout</MenuHeading>
              <MenuItem
                theme={theme}
                label="Unified"
                checked={view.layout === "unified"}
                onPress={() => setView({ layout: "unified" })}
              />
              <MenuItem
                theme={theme}
                label="Split"
                checked={view.layout === "split"}
                onPress={() => setView({ layout: "split" })}
              />
              <MenuSeparator theme={theme} />
            </>
          )}
          <MenuItem
            theme={theme}
            label="Wrap lines"
            hint={view.layout === "split" ? "Split view always wraps" : undefined}
            checked={view.wrapLines || view.layout === "split"}
            disabled={view.layout === "split"}
            onPress={() => setView({ wrapLines: !view.wrapLines })}
          />
          <MenuItem
            theme={theme}
            label="Hide whitespace"
            checked={view.hideWhitespace}
            onPress={() => setView({ hideWhitespace: !view.hideWhitespace })}
          />
          {languageFeatures ? (
            <MenuItem
              theme={theme}
              label="Hover and go to definition"
              hint={trusted ? undefined : "Asks you to trust this project"}
              checked={trusted}
              onPress={() => {
                setMenu(null);
                if (trusted) review.setTrust(false);
                else setTrustPrompt(true);
              }}
            />
          ) : null}
          <MenuSeparator theme={theme} />
          <MenuHeading theme={theme}>File list</MenuHeading>
          <MenuItem
            theme={theme}
            label="Flat"
            checked={view.fileList === "flat"}
            onPress={() => setView({ fileList: "flat" })}
          />
          <MenuItem
            theme={theme}
            label="Tree"
            checked={view.fileList === "tree"}
            onPress={() => setView({ fileList: "tree" })}
          />
          <MenuSeparator theme={theme} />
          <MenuHeading theme={theme}>Files</MenuHeading>
          <MenuItem theme={theme} label="Collapse all" onPress={() => foldAll(true)} />
          <MenuItem theme={theme} label="Expand all" onPress={() => foldAll(false)} />
        </Dropdown>
        <IconButton
          theme={theme}
          icon="RefreshCw"
          label="Reload changes from git"
          disabled={review.refreshing}
          onPress={review.refresh}
        />
      </View>

      {languageFeatures && review.trust === "undecided" ? (
        <TrustNotice theme={theme} onTrust={() => setTrustPrompt(true)} onKeepOff={() => review.setTrust(false)} />
      ) : null}
      <TrustDialog
        theme={theme}
        project={workspace.projectDisplayName}
        open={trustPrompt}
        onOpenChange={setTrustPrompt}
        onTrust={() => review.setTrust(true)}
      />
      {live.status === "failed" ? (
        <Text style={{ color: theme.colors.statusDanger, padding: 16 }}>{live.error}</Text>
      ) : tab === "guided" ? (
        <GuidedView
          theme={theme}
          narrow={narrow}
          view={view}
          onResizePane={resizePane}
          fold={fold}
          live={live}
          guide={review.guide}
          guideError={review.guideError}
          generate={review.generate}
          viewedMarks={review.state.viewed}
          setViewed={review.setViewed}
          comments={comments}
          openAgent={navigation == null ? undefined : (agentId) => navigation.openAgent({ agentId })}
        />
      ) : live.status === "ready" ? (
        <FullView
          theme={theme}
          narrow={narrow}
          view={view}
          onResizePane={resizePane}
          fold={fold}
          diff={live.diff}
          source={live.source}
          comments={comments}
        />
      ) : (
        <Text style={{ ...muted, padding: 16 }}>Reading the diff…</Text>
      )}
    </View>
  );
}

/** Persisted in the host settings; narrow layouts always show the unified layout. */
function useViewOptions(narrow: boolean): { view: ViewOptions; setView(change: Partial<ViewOptions>): void } {
  const settings = useSettings(reviewSettings);
  const [pending, setPending] = useState<Partial<ViewOptions>>({});
  const savedAgainst = useRef<string | null>(null);
  const stored = settings.status === "ready" ? settings.values : DEFAULT_SETTINGS;
  const { layout, wrapLines, hideWhitespace, fileList, paneWidth } = stored;
  // Every file row is memoised on it, so a new object per render re-renders them all.
  const view = useMemo(
    (): ViewOptions => ({
      layout: narrow ? "unified" : (pending.layout ?? layout),
      wrapLines: pending.wrapLines ?? wrapLines,
      hideWhitespace: pending.hideWhitespace ?? hideWhitespace,
      fileList: pending.fileList ?? fileList,
      paneWidth: pending.paneWidth ?? paneWidth,
    }),
    [narrow, pending, layout, wrapLines, hideWhitespace, fileList, paneWidth],
  );

  useEffect(() => {
    if (settings.status !== "ready") return;
    const unsaved = withoutStored(pending, settings.values);
    if (Object.keys(unsaved).length !== Object.keys(pending).length) {
      setPending(unsaved);
      return;
    }
    // save() rejects a stale revision: one save per revision, the rest once the next one arrives.
    if (Object.keys(unsaved).length === 0 || settings.revision === savedAgainst.current) return;
    savedAgainst.current = settings.revision;
    void settings.save({ ...settings.values, ...unsaved }, settings.revision);
  }, [settings, pending]);

  return {
    view,
    setView: (change) => setPending((current) => ({ ...current, ...change })),
  };
}

function withoutStored(pending: Partial<ViewOptions>, stored: ViewOptions): Partial<ViewOptions> {
  const unsaved = { ...pending };
  for (const key of VIEW_KEYS) {
    if (unsaved[key] === stored[key]) delete unsaved[key];
  }
  return unsaved;
}
