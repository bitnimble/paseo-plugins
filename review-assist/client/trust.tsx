import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { Button, Notice } from "./controls";
import { MONOSPACE } from "./palette";

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
          <Button theme={theme} size="xs" label="Trust workspace…" onPress={onTrust} />
          <Button theme={theme} size="xs" variant="ghost" label="Keep off" onPress={onKeepOff} />
        </>
      }
    >
      Hover and go to definition are off until you trust this workspace.
    </Notice>
  );
}

export function TrustDialog({
  theme,
  directory,
  open,
  onOpenChange,
  onTrust,
}: {
  theme: PluginTheme;
  directory: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onTrust(): void;
}) {
  const body = { fontSize: 14, lineHeight: 20, color: theme.colors.foreground };
  return (
    <Modal title="Trust this workspace?" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Text style={{ ...body, fontFamily: MONOSPACE, fontSize: 12, color: theme.colors.foregroundMuted }}>
          {directory}
        </Text>
        <Text style={body}>
          Hover, go to definition and references start a language server here, and language servers can run the
          workspace's code: TypeScript loads the workspace's own typescript package, and rust-analyzer runs build
          scripts and macros.
        </Text>
        <Text style={body}>Trust it only if you would run its code yourself. Syntax highlighting works either way.</Text>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <Button theme={theme} variant="ghost" label="Cancel" onPress={() => onOpenChange(false)} />
          <Button
            theme={theme}
            variant="default"
            icon="ShieldCheck"
            label="Trust workspace"
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
