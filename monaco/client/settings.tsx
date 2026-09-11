import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { SERVER_LABELS } from "../shared/languages";
import { MONACO_DEFAULT_BASE, editorSettings, type EditorSettings } from "../shared/settings";

const FONT_SIZES = ["11", "12", "13", "14", "16", "18"] as const;
const TAB_SIZES = ["2", "4", "8"] as const;

export function EditorSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(editorSettings);

  if (settings.status !== "ready") {
    return (
      <View style={{ padding: 24 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {settings.status === "loading" ? "Loading settings…" : settings.error}
        </Text>
      </View>
    );
  }

  const { values, revision } = settings;
  const update = (patch: Partial<EditorSettings>) => void settings.save({ ...values, ...patch }, revision);

  return (
    <View>
      {settings.saveError == null ? null : (
        <Text style={{ color: theme.colors.statusDanger, paddingHorizontal: 16 }}>
          {settings.saveError}
        </Text>
      )}

      <SettingsSection title="Editor">
        <SettingsCard>
          <SettingsSelect
            label="Font size"
            value={String(values.fontSize)}
            options={FONT_SIZES.map((size) => ({ label: size, value: size }))}
            onValueChange={(size) => update({ fontSize: Number(size) })}
          />
          <SettingsSelect
            label="Tab size"
            value={String(values.tabSize)}
            options={TAB_SIZES.map((size) => ({ label: size, value: size }))}
            onValueChange={(size) => update({ tabSize: Number(size) })}
          />
          <SettingsSwitch
            label="Word wrap"
            value={values.wordWrap}
            onValueChange={(wordWrap) => update({ wordWrap })}
          />
          <SettingsSwitch
            label="Minimap"
            value={values.minimap}
            onValueChange={(minimap) => update({ minimap })}
          />
          <SettingsSwitch
            label="Line numbers"
            value={values.lineNumbers}
            onValueChange={(lineNumbers) => update({ lineNumbers })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Language servers"
        info="Full command line, run on the daemon machine. Blank uses the built-in default."
      >
        <SettingsCard>
          {Object.entries(SERVER_LABELS).map(([serverId, label]) => (
            <SettingsInput
              key={serverId}
              label={label}
              placeholder={label}
              initialValue={values.languageServers[serverId] ?? ""}
              onChangeText={(command) =>
                update({ languageServers: { ...values.languageServers, [serverId]: command } })
              }
            />
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Monaco">
        <SettingsCard>
          <SettingsInput
            label="Base URL"
            hint="Point this at a self-hosted copy when the app cannot reach the CDN. Applies after the app reloads."
            placeholder={MONACO_DEFAULT_BASE}
            initialValue={values.monacoBaseUrl}
            onChangeText={(monacoBaseUrl) => update({ monacoBaseUrl })}
          />
          <SettingsAction
            label="Restore defaults"
            actionLabel="Reset"
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
