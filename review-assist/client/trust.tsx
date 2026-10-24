import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { Button, Notice } from "./controls";

export function TrustNotice({
  theme,
  onTrust,
  onKeepOff,
}: {
  theme: PluginTheme;
  onTrust(): void;
  onKeepOff(): void;
}) {
  return (
    <Notice
      theme={theme}
      icon="ShieldAlert"
      actions={
        <>
          <Button theme={theme} size="xs" label="Trust project…" onPress={onTrust} />
          <Button theme={theme} size="xs" variant="ghost" label="Keep off" onPress={onKeepOff} />
        </>
      }
    >
      Hover and go to definition are off until you trust this project.
    </Notice>
  );
}

export function TrustDialog({
  theme,
  project,
  open,
  onOpenChange,
  onTrust,
}: {
  theme: PluginTheme;
  project: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onTrust(): void;
}) {
  const body = { fontSize: 14, lineHeight: 20, color: theme.colors.foreground };
  return (
    <Modal title={`Trust ${project}?`} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Text style={body}>
          Hover, go to definition and references start a language server in this project's workspaces, and language
          servers can run the project's code: TypeScript loads the project's own typescript package, and rust-analyzer
          runs build scripts and macros.
        </Text>
        <Text style={body}>
          This covers every workspace of the project. Trust it only if you would run its code yourself. Syntax
          highlighting works either way.
        </Text>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <Button theme={theme} variant="ghost" label="Cancel" onPress={() => onOpenChange(false)} />
          <Button
            theme={theme}
            variant="default"
            icon="ShieldCheck"
            label="Trust project"
            onPress={() => {
              onTrust();
              onOpenChange(false);
            }}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
