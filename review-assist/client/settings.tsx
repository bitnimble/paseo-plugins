import { type PluginSurfaceProps, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Text } from "react-native";
import { messageOf } from "../shared/errors";
import { type ModelChoice, automaticChoice, modelChoices } from "../shared/models";
import { type UpdateStatus, updateRpc, updateStatusRpc } from "../shared/protocol";
import { reviewSettings } from "../shared/settings";

const UPDATE_KEY = ["review-update"];
const UPDATING_POLL_MS = 3000;
const RESTART_GRACE_MS = 30_000;

export function ReviewSettingsScreen(props: PluginSurfaceProps) {
  return (
    <>
      <ModelSettings {...props} />
      <UpdateSettings />
    </>
  );
}

type ProvidersSnapshot = Awaited<ReturnType<ReturnType<typeof usePaseo>["providers"]["waitForReady"]>>;

export function useProviders(enabled = true): UseQueryResult<ProvidersSnapshot> {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["review-providers"],
    queryFn: () => paseo.providers.waitForReady({ timeoutMs: 30_000 }),
    enabled,
  });
}

function ModelSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(reviewSettings);
  const providers = useProviders();

  if (settings.status !== "ready") {
    return (
      <Text style={{ color: settings.status === "loading" ? theme.colors.foregroundMuted : theme.colors.statusDanger }}>
        {settings.status === "loading" ? "Loading settings…" : settings.error}
      </Text>
    );
  }

  const choices = modelChoices(providers.data?.entries ?? []);
  const automatic = automaticChoice(choices);
  const { model, backupModel } = settings.values;

  return (
    <SettingsSection title="Guided review">
      <SettingsCard>
        <SettingsSelect
          label="Model"
          hint="The agent that splits a diff into sections. Runs once per generation, in the reviewed workspace."
          error={settings.saveError}
          disabled={settings.saving}
          value={model}
          options={[
            { value: "", label: automatic == null ? "Automatic" : `Automatic (${automatic.label})` },
            ...savedOptionsNotOffered(model, choices),
            ...choices,
          ]}
          onValueChange={(next) => void settings.save({ ...settings.values, model: next }, settings.revision)}
        />
        <SettingsSelect
          label="Backup model"
          hint="Takes over when the model's provider isn't ready or a run on it fails, such as when it's out of quota. With None, the generation fails instead."
          error={settings.saveError}
          disabled={settings.saving}
          value={backupModel}
          options={[{ value: "", label: "None" }, ...savedOptionsNotOffered(backupModel, choices), ...choices]}
          onValueChange={(next) => void settings.save({ ...settings.values, backupModel: next }, settings.revision)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function savedOptionsNotOffered(saved: string, choices: readonly ModelChoice[]): { value: string; label: string }[] {
  return saved === "" || choices.some((choice) => choice.value === saved) ? [] : [{ value: saved, label: saved }];
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
