import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { MENU_HOST_Z_INDEX, MenuBackdrop } from "../kit/client/menu";
import { ModelMenu } from "../kit/client/model-menu";
import { UpdateSettings } from "../kit/client/update-settings";
import { messageOf } from "../kit/shared/errors";
import { difftasticStatusRpc } from "../shared/protocol";
import { reviewSettings } from "../shared/settings";
import { DIFFTASTIC_KEY, SYNTAX_DIFF_KEY, useDifftasticStatus } from "./use-code";

const MODEL_ROWS = [
  {
    key: "model",
    label: "Model",
    hint: "The agent that splits a diff into sections. Runs once per generation, in the reviewed workspace.",
    unset: "automatic",
  },
  {
    key: "backupModel",
    label: "Backup model",
    hint: "Takes over when the model's provider isn't ready or a run on it fails, such as when it's out of quota. With None, the generation fails instead.",
    unset: "none",
  },
] as const;
type ModelKey = (typeof MODEL_ROWS)[number]["key"];

const SECTION_LINE_OPTIONS = [200, 500, 1000, 2000].map((lines) => ({
  label: `About ${lines} lines`,
  value: String(lines),
}));

const CONTEXT_LINE_OPTIONS = [0, 3, 5, 10, 20].map((lines) => ({
  label: lines === 0 ? "None" : `${lines} lines`,
  value: String(lines),
}));

export function ReviewSettingsScreen(props: PluginSurfaceProps) {
  const [menu, setMenu] = useState<ModelKey | null>(null);
  return (
    <View>
      {menu == null ? null : <MenuBackdrop fillsWindow onPress={() => setMenu(null)} />}
      <ModelSettings {...props} menu={menu} onMenu={setMenu} />
      <DiffSettings />
      <UpdateSettings />
    </View>
  );
}

function DiffSettings() {
  const settings = useSettings(reviewSettings);
  const readStatus = useRpc(difftasticStatusRpc);
  const queryClient = useQueryClient();
  const check = useDifftasticStatus();
  const recheck = useMutation({
    mutationFn: () => readStatus({ recheck: true }),
    onSuccess: (status) => {
      queryClient.setQueryData(DIFFTASTIC_KEY, status);
      void queryClient.invalidateQueries({ queryKey: SYNTAX_DIFF_KEY });
    },
  });
  if (settings.status !== "ready") return null;
  const status = check.data;
  const available = status?.status === "available";
  const checking = check.isFetching || recheck.isPending;
  const hint =
    status == null
      ? "Checking for difftastic…"
      : status.status === "available"
        ? `Pairs and highlights changed lines by syntax with difftastic ${status.version}. Sections still follow git's hunks.`
        : `${status.reason} Install difftastic there, then check again.`;
  return (
    <SettingsSection title="Diff display">
      <SettingsCard>
        <SettingsSwitch
          label="Syntax-aware diffs"
          hint={hint}
          value={available && settings.values.difftastic}
          disabled={!available || settings.saving}
          error={settings.saveError ?? (check.error == null ? null : messageOf(check.error))}
          onValueChange={(difftastic) => void settings.save({ ...settings.values, difftastic }, settings.revision)}
        />
        <SettingsAction
          label="difftastic"
          hint={available ? `Found difft ${status.version}` : "Not found"}
          actionLabel={checking ? "Checking…" : "Check again"}
          disabled={checking}
          error={recheck.error == null ? null : messageOf(recheck.error)}
          onPress={() => recheck.mutate()}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function ModelSettings({
  theme,
  menu,
  onMenu,
}: PluginSurfaceProps & { menu: ModelKey | null; onMenu(menu: ModelKey | null): void }) {
  const settings = useSettings(reviewSettings);
  const card = useRef<View>(null);

  if (settings.status !== "ready") {
    return (
      <Text style={{ color: settings.status === "loading" ? theme.colors.foregroundMuted : theme.colors.statusDanger }}>
        {settings.status === "loading" ? "Loading settings…" : settings.error}
      </Text>
    );
  }

  return (
    <View
      // Not a disabled Pressable: its aria-disabled reaches the triggers.
      onStartShouldSetResponder={() => menu != null}
      onResponderRelease={() => onMenu(null)}
      style={{ zIndex: MENU_HOST_Z_INDEX }}
    >
      <SettingsSection title="Guided review">
        {/* Not SettingsCard: it clips the menus at its edge. */}
        <View
          ref={card}
          collapsable={false}
          style={{
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          {MODEL_ROWS.map(({ key, label, hint, unset }, index) => (
            <View
              key={key}
              style={{
                // Upper rows on top: a menu opens down over the rows after it.
                zIndex: MODEL_ROWS.length - index,
                ...(index === 0 ? {} : { borderTopWidth: 1, borderTopColor: theme.colors.border }),
              }}
            >
              <SettingsRow label={label} hint={hint} error={settings.saveError}>
                <ModelMenu
                  theme={theme}
                  name={label}
                  value={settings.values[key]}
                  unset={unset}
                  field={{ disabled: settings.saving }}
                  bounds={card}
                  open={menu === key}
                  onOpenChange={(open) => onMenu(open ? key : null)}
                  onPick={(next) => {
                    onMenu(null);
                    void settings.save({ ...settings.values, [key]: next }, settings.revision);
                  }}
                />
              </SettingsRow>
            </View>
          ))}
          <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}>
            <SettingsSelect
              label="Section size"
              hint="Changed lines a section aims for. A guide, not a limit: mechanical updates, such as every caller of a changed signature, stay in one section however large."
              value={String(settings.values.sectionLines)}
              options={SECTION_LINE_OPTIONS}
              disabled={settings.saving}
              error={settings.saveError}
              onValueChange={(next) =>
                void settings.save({ ...settings.values, sectionLines: Number(next) }, settings.revision)
              }
            />
          </View>
          <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}>
            <SettingsSelect
              label="Surrounding lines"
              hint="Unchanged lines shown to the model on each side of every change, besides the diff's own."
              value={String(settings.values.promptContextLines)}
              options={CONTEXT_LINE_OPTIONS}
              disabled={settings.saving}
              error={settings.saveError}
              onValueChange={(next) =>
                void settings.save({ ...settings.values, promptContextLines: Number(next) }, settings.revision)
              }
            />
          </View>
          <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}>
            <SettingsSwitch
              label="Enclosing declarations"
              hint="Show the model the signatures of the functions, classes and modules each change sits in."
              value={settings.values.promptScope}
              disabled={settings.saving}
              error={settings.saveError}
              onValueChange={(next) => void settings.save({ ...settings.values, promptScope: next }, settings.revision)}
            />
          </View>
        </View>
      </SettingsSection>
    </View>
  );
}

