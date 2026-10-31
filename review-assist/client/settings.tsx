import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { messageOf } from "../shared/errors";
import { type UpdateStatus, updateRpc, updateStatusRpc } from "../shared/protocol";
import { reviewSettings } from "../shared/settings";
import { MENU_HOST_Z_INDEX, MenuBackdrop } from "./menu";
import { ModelMenu } from "./model-menu";

const UPDATE_KEY = ["review-update"];
const UPDATING_POLL_MS = 3000;
const RESTART_GRACE_MS = 30_000;

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

export function ReviewSettingsScreen(props: PluginSurfaceProps) {
  const [menu, setMenu] = useState<ModelKey | null>(null);
  return (
    <View>
      {menu == null ? null : <MenuBackdrop fillsWindow onPress={() => setMenu(null)} />}
      <ModelSettings {...props} menu={menu} onMenu={setMenu} />
      <UpdateSettings />
    </View>
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
        </View>
      </SettingsSection>
    </View>
  );
}

function UpdateSettings() {
  const readStatus = useRpc(updateStatusRpc);
  const install = useRpc(updateRpc);
  const queryClient = useQueryClient();
  const check = useQuery({
    queryKey: UPDATE_KEY,
    queryFn: () => readStatus({}),
    // Calls fail for a moment while the plugin restarts into the update; keep polling through them.
    refetchInterval: (query) => (query.state.data?.status === "updating" ? UPDATING_POLL_MS : false),
  });
  const update = useMutation({
    mutationFn: () => install({}),
    onSuccess: () => queryClient.setQueryData<UpdateStatus>(UPDATE_KEY, { status: "updating" }),
  });
  const status = check.data;
  const restarting = status?.status === "updating";
  const unreachable = check.isError && check.errorUpdatedAt - check.dataUpdatedAt > RESTART_GRACE_MS;
  const updating = update.isPending || (restarting && !unreachable);
  const checking = check.isFetching && !updating;
  const available = status?.status === "available";
  const installFailure = available ? (update.error == null ? status.failure : messageOf(update.error)) : null;
  const error = installFailure ?? (check.error != null && (!restarting || unreachable) ? messageOf(check.error) : null);

  return (
    <SettingsSection title="Updates">
      <SettingsCard>
        <SettingsAction
          {...updateRow(status, checking)}
          error={error}
          actionLabel={updating ? "Updating…" : available ? "Update" : checking ? "Checking…" : "Check again"}
          disabled={updating || checking}
          onPress={() => (available ? update.mutate() : void check.refetch())}
        />
        {status?.status === "available" && status.review != null ? (
          <SettingsRow label="Changes">
            <ExternalLink href={status.review}>Review the changes</ExternalLink>
          </SettingsRow>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function updateRow(status: UpdateStatus | undefined, checking: boolean): { label: string; hint: string } {
  if (status == null) return { label: "Updates", hint: checking ? "Checking for an update…" : "" };
  switch (status.status) {
    case "available":
      return { label: "Update available", hint: `${status.current} → ${status.target}` };
    case "updating":
      return { label: "Updating", hint: "Building the new version. The plugin restarts on it when it's ready." };
    case "current":
      return { label: "Up to date", hint: `At ${status.revision}` };
    case "unavailable":
      return { label: "Updates", hint: status.reason };
  }
}
