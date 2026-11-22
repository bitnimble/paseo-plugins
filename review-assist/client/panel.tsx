import { type PluginWorkspacePanelProps, useSettings, useTabState, useWorkspace } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import { DEFAULT_BRANCH_MODE, type DiffMode, diffModeSchema, modeKey } from "../shared/protocol";
import { type ReviewSettings, type SectionsLayout, type ViewOptions, reviewSettings } from "../shared/settings";
import { IconButton, Tabs } from "./controls";
import type { FoldCommand } from "./diff-list";
import { ErrorBoundary } from "./error-boundary";
import { FullView } from "./full-view";
import { GuidedView } from "./guided-view";
import { Dropdown, MENU_HOST_Z_INDEX, MenuBackdrop, MenuHeading, MenuItem, MenuSeparator } from "./menu";
import { ModeMenu } from "./mode-menu";
import { ModelMenu } from "./model-menu";
import { MONOSPACE, compactCount } from "./palette";
import { fitsPane } from "./panes";
import { LanguageFeatures } from "./peek";
import { type ScrollAnchor, scrollAnchorSchema } from "./scroll-anchor";
import { SendComments } from "./send-comments";
import { TrustDialog, TrustNotice } from "./trust";
import { useCodeIntelligence, useDifftasticStatus } from "./use-code";
import { useSharedMode } from "./use-mode";
import { commentStore, useReview } from "./use-review";

type Menu = "mode" | "view" | "model" | "refresh";
type SavedOptions = Pick<ReviewSettings, (typeof SAVED_KEYS)[number]>;
type SavedViewOptions = Omit<SavedOptions, "model" | "sectionsNarrow" | "sectionsWide">;

const placeSchema = z.object({
  mode: diffModeSchema,
  tab: z.enum(["guided", "full"]),
  section: z.number().int().nonnegative(),
  scrollGuided: scrollAnchorSchema.optional(),
  scrollFull: scrollAnchorSchema.optional(),
});
type Place = z.infer<typeof placeSchema>;
type Tab = Place["tab"];
const START: Place = { mode: DEFAULT_BRANCH_MODE, tab: "guided", section: 0 };

const TABS: readonly { value: Tab; label: string }[] = [
  { value: "guided", label: "Guided" },
  { value: "full", label: "Full diff" },
];

const SAVED_KEYS = [
  "model",
  "layout",
  "wrapLines",
  "hideWhitespace",
  "fileList",
  "paneWidth",
  "showPane",
  "sectionsNarrow",
  "sectionsWide",
] as const;
const DEFAULT_SETTINGS = reviewSettings.schema.parse({});

export function ReviewPanel(props: PluginWorkspacePanelProps) {
  return (
    <ErrorBoundary theme={props.theme}>
      <Review {...props} />
    </ErrorBoundary>
  );
}

function Review({ theme, layout, workspaceId, navigation, tab: panelTab }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ directory, projectId, projectDisplayName, projectKind, diffStat }) => ({
    directory,
    projectId,
    projectDisplayName,
    projectKind,
    additions: diffStat?.additions,
    deletions: diffStat?.deletions,
  }));
  const [sharedMode, shareMode] = useSharedMode(workspace?.directory ?? null);
  const [saved, setPlace] = useTabState(panelTab, placeSchema, START);
  const sharedValue = sharedMode.status === "ready" ? sharedMode.mode : null;
  const mode = sharedValue ?? saved.mode;
  // Another device switched the workspace's mode: this tab's section and scroll were for the old diff.
  const place: Place = modeKey(saved.mode) === modeKey(mode) ? saved : { mode, tab: saved.tab, section: 0 };
  const unshared = sharedMode.status === "ready" && sharedMode.mode == null;
  const tabHasPlace = panelTab.state != null;
  useEffect(() => {
    // A tab that was already open holds the workspace's only record of its mode; a new tab's is just the default.
    if (unshared && tabHasPlace) shareMode(saved.mode);
  }, [unshared, tabHasPlace]);
  const { tab, section } = place;
  const placeRef = useRef(place);
  placeRef.current = place;
  const setScrollGuided = (scrollGuided: ScrollAnchor) =>
    setPlace({ ...placeRef.current, scrollGuided, section: scrollGuided.section ?? placeRef.current.section });
  const setScrollFull = (scrollFull: ScrollAnchor) => setPlace({ ...placeRef.current, scrollFull });
  const [menu, setMenu] = useState<Menu | null>(null);
  const toolbar = useRef<View>(null);
  const [fold, setFold] = useState<FoldCommand | null>(null);
  const [fits, setFits] = useState(true);
  const narrow = layout.compact || !fits;
  const [drawerOpen, setDrawerOpen] = useState(false);
  if (!narrow && drawerOpen) setDrawerOpen(false);
  const { view, model, setView, setSections, setModel } = useSavedOptions(narrow);
  const review = useReview({
    workspaceId,
    directory: sharedMode.status === "loading" ? null : (workspace?.directory ?? null),
    projectId: workspace?.projectId ?? null,
    mode,
    revision: `${workspace?.additions}:${workspace?.deletions}`,
  });
  const { live } = review;
  if (drawerOpen && live.status !== "ready") setDrawerOpen(false);
  const [trustPrompt, setTrustPrompt] = useState(false);
  const trusted = review.trust === "trusted";
  const projectId = workspace?.projectId;
  const languageFeatures = useMemo(() => (trusted && projectId != null ? { projectId } : null), [trusted, projectId]);
  useCodeIntelligence(
    languageFeatures != null && live.status === "ready" ? { ...languageFeatures, root: live.source.root } : null,
  );
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };

  if (workspace == null || sharedMode.status === "loading") return <Loading />;
  if (workspace.projectKind !== "git") {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>Guided review needs a git repository.</Text>
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
  const generating = review.guide?.job?.status === "running";
  const comments = commentStore(review);
  const resizePane = (paneWidth: number) => setView({ paneWidth });
  const paneShown = narrow ? drawerOpen : view.showPane;
  const closeDrawer = () => setDrawerOpen(false);
  const pickMode = (next: DiffMode) => {
    if (sharedValue == null || modeKey(next) !== modeKey(sharedValue)) shareMode(next);
    if (modeKey(next) !== modeKey(mode)) setPlace({ mode: next, tab, section: 0 });
    setDrawerOpen(false);
    setMenu(null);
  };
  const pickModel = (next: string) => {
    setModel(next);
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
        ref={toolbar}
        collapsable={false}
        style={{
          zIndex: MENU_HOST_Z_INDEX,
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
        <IconButton
          theme={theme}
          icon={paneShown ? "PanelLeftClose" : "PanelLeftOpen"}
          label={paneShown ? "Hide the side pane" : "Show the side pane"}
          tooltipSide="start"
          onPress={() => (narrow ? setDrawerOpen(!drawerOpen) : setView({ showPane: !view.showPane }))}
        />
        <Tabs<Tab>
          theme={theme}
          value={tab}
          options={TABS}
          onChange={(next) => {
            setPlace({ ...place, tab: next });
            setDrawerOpen(false);
          }}
        />
        <ModeMenu
          theme={theme}
          directory={workspace.directory}
          mode={mode}
          base={live.status === "ready" ? live.base : null}
          bounds={toolbar}
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
        <ModelMenu
          theme={theme}
          value={model}
          bounds={toolbar}
          open={menu === "model"}
          onOpenChange={openMenu("model")}
          onPick={pickModel}
        />
        <Dropdown
          theme={theme}
          label="View"
          icon="SlidersHorizontal"
          bounds={toolbar}
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
          {tab === "guided" ? (
            <>
              <MenuHeading theme={theme}>Sections</MenuHeading>
              <MenuItem
                theme={theme}
                label="One at a time"
                checked={view.sections === "paged"}
                onPress={() => setSections("paged")}
              />
              <MenuItem
                theme={theme}
                label="All in one scroll"
                checked={view.sections === "continuous"}
                onPress={() => setSections("continuous")}
              />
              <MenuSeparator theme={theme} />
            </>
          ) : null}
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
        <Dropdown
          theme={theme}
          label="Refresh"
          icon="RefreshCw"
          bounds={toolbar}
          open={menu === "refresh"}
          onOpenChange={openMenu("refresh")}
        >
          <MenuItem
            theme={theme}
            label="Refresh Git state"
            disabled={review.refreshing}
            onPress={() => {
              setMenu(null);
              review.refresh();
            }}
          />
          <MenuItem
            theme={theme}
            label={review.guide?.record == null ? "Generate guided review" : "Regenerate guided review"}
            hint={generating ? "Already running" : undefined}
            disabled={generating || live.status !== "ready" || live.diff.files.length === 0}
            onPress={() => {
              setMenu(null);
              setPlace({ ...place, tab: "guided" });
              review.generate();
            }}
          />
        </Dropdown>
      </View>

      {review.trust === "undecided" ? (
        <TrustNotice theme={theme} onTrust={() => setTrustPrompt(true)} onKeepOff={() => review.setTrust(false)} />
      ) : null}
      <TrustDialog
        theme={theme}
        project={workspace.projectDisplayName}
        open={trustPrompt}
        onOpenChange={setTrustPrompt}
        onTrust={() => review.setTrust(true)}
      />
      <LanguageFeatures.Provider value={languageFeatures}>
        {live.status === "failed" ? (
          <Text style={{ color: theme.colors.statusDanger, padding: 16 }}>{live.error}</Text>
        ) : tab === "guided" ? (
          <GuidedView
            theme={theme}
            narrow={narrow}
            paneShown={paneShown}
            onCloseDrawer={closeDrawer}
            view={view}
            onResizePane={resizePane}
            fold={fold}
            live={live}
            guide={review.guide}
            guideError={review.guideError}
            generate={review.generate}
            section={section}
            onSection={(next) => setPlace({ ...place, section: next })}
            scroll={place.scrollGuided}
            onScroll={setScrollGuided}
            stateLoaded={review.stateLoaded}
            viewedMarks={review.state.viewed}
            setViewed={review.setViewed}
            comments={comments}
            openAgent={navigation == null ? undefined : (agentId) => navigation.openAgent({ agentId })}
          />
        ) : live.status === "ready" ? (
          <FullView
            theme={theme}
            narrow={narrow}
            paneShown={paneShown}
            onCloseDrawer={closeDrawer}
            view={view}
            onResizePane={resizePane}
            fold={fold}
            diff={live.diff}
            source={live.source}
            scroll={place.scrollFull}
            onScroll={setScrollFull}
            stateLoaded={review.stateLoaded}
            comments={comments}
          />
        ) : (
          <Loading />
        )}
      </LanguageFeatures.Provider>
    </View>
  );
}

/** Persisted in the host settings; narrow layouts always show the unified layout, and keep their own sections layout. */
function useSavedOptions(narrow: boolean): {
  view: ViewOptions;
  model: string;
  setView(change: Partial<SavedViewOptions>): void;
  setSections(sections: SectionsLayout): void;
  setModel(model: string): void;
} {
  const settings = useSettings(reviewSettings);
  const [pending, setPending] = useState<Partial<SavedOptions>>({});
  const savedAgainst = useRef<string | null>(null);
  const stored = settings.status === "ready" ? settings.values : DEFAULT_SETTINGS;
  const {
    model,
    layout,
    wrapLines,
    hideWhitespace,
    difftastic,
    fileList,
    paneWidth,
    showPane,
    sectionsNarrow,
    sectionsWide,
  } = { ...stored, ...pending };
  const difftasticMissing = useDifftasticStatus().data?.status === "missing";
  const sections = narrow ? sectionsNarrow : sectionsWide;
  // Every file row is memoised on it, so a new object per render re-renders them all.
  const view = useMemo(
    (): ViewOptions => ({
      layout: narrow ? "unified" : layout,
      wrapLines,
      hideWhitespace,
      difftastic: difftastic && !difftasticMissing,
      fileList,
      paneWidth,
      showPane,
      sections,
    }),
    [narrow, layout, wrapLines, hideWhitespace, difftastic, difftasticMissing, fileList, paneWidth, showPane, sections],
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
    model,
    setView: (change) => setPending((current) => ({ ...current, ...change })),
    setSections: (next) =>
      setPending((current) => ({ ...current, ...(narrow ? { sectionsNarrow: next } : { sectionsWide: next }) })),
    setModel: (next) => setPending((current) => ({ ...current, model: next })),
  };
}

function withoutStored(pending: Partial<SavedOptions>, stored: SavedOptions): Partial<SavedOptions> {
  const unsaved = { ...pending };
  for (const key of SAVED_KEYS) {
    if (unsaved[key] === stored[key]) delete unsaved[key];
  }
  return unsaved;
}
