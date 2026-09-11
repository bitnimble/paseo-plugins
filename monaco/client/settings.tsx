import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { DEFAULT_COMMAND, editorSettings, type ServerSettings } from "../shared/settings";

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
  const update = (patch: Partial<ServerSettings>) => void settings.save({ ...values, ...patch }, revision);

  return (
    <View>
      {settings.saveError == null ? null : (
        <Text style={{ color: theme.colors.statusDanger, paddingHorizontal: 16 }}>
          {settings.saveError}
        </Text>
      )}

      <SettingsSection
        title="Editor server"
        info="Changes apply the next time the server starts, which is after the last editor tab closes."
      >
        <SettingsCard>
          <SettingsInput
            label="Command"
            hint="Runs on the daemon machine and must be on its PATH, or an absolute path."
            placeholder={DEFAULT_COMMAND}
            initialValue={values.command}
            onChangeText={(command) => update({ command })}
          />
          <SettingsInput
            label="Extra arguments"
            hint="Appended to --host, --port and --connection-token."
            placeholder="--extensions-dir /path"
            initialValue={values.extraArgs}
            onChangeText={(extraArgs) => update({ extraArgs })}
          />
          <SettingsInput
            label="Bind address"
            hint="127.0.0.1 keeps the server off the network. Widen it only behind a trusted network."
            placeholder="127.0.0.1"
            initialValue={values.bindHost}
            onChangeText={(bindHost) => update({ bindHost })}
          />
          <SettingsInput
            label="Public URL"
            hint="Set this when the app is not on the daemon machine and reaches the server through a proxy or tunnel."
            placeholder="https://editor.example.com"
            initialValue={values.publicUrl}
            onChangeText={(publicUrl) => update({ publicUrl })}
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
