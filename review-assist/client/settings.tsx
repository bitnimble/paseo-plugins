import { type PluginSurfaceProps, usePaseo, useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { modelChoices } from "../shared/models";
import { reviewSettings } from "../shared/settings";

export function ReviewSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(reviewSettings);
  const paseo = usePaseo();
  const providers = useQuery({
    queryKey: ["review-providers"],
    queryFn: () => paseo.providers.waitForReady({ timeoutMs: 30_000 }),
  });

  if (settings.status !== "ready") {
    return (
      <Text style={{ color: settings.status === "loading" ? theme.colors.foregroundMuted : theme.colors.statusDanger }}>
        {settings.status === "loading" ? "Loading settings…" : settings.error}
      </Text>
    );
  }

  const choices = modelChoices(providers.data?.entries ?? []);
  const current = settings.values.model;
  const options = [
    { value: "", label: choices[0] == null ? "Automatic" : `Automatic (${choices[0].label})` },
    ...(current === "" || choices.some((choice) => choice.value === current)
      ? []
      : [{ value: current, label: current }]),
    ...choices,
  ];

  return (
    <SettingsSection title="Guided review">
      <SettingsCard>
        <SettingsSelect
          label="Model"
          hint="The agent that splits a diff into sections. Runs once per generation, in the reviewed workspace."
          error={settings.saveError}
          disabled={settings.saving}
          value={current}
          options={options}
          onValueChange={(model) => void settings.save({ ...settings.values, model }, settings.revision)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
