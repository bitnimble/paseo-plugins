import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { type ReactNode, type RefObject, useState } from "react";
import { Pressable, Text, type View } from "react-native";
import { type ProviderChoice, automaticChoice, modelChoices, providerChoices } from "../shared/models";
import { Dropdown, MenuItem, MenuSeparator } from "./menu";
import { useProviders } from "./use-providers";

export function BrowserBack({
  theme,
  title,
  accessibilityLabel,
  onPress,
}: {
  theme: PluginTheme;
  title: string;
  accessibilityLabel: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Icon name="ChevronLeft" size={16} color={theme.colors.foregroundMuted} />
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.foreground }}>{title}</Text>
    </Pressable>
  );
}

export function ModelOptions({
  theme,
  providers,
  opened,
  value,
  marksProviderOfValue = false,
  onOpen,
  onPick,
  children,
}: {
  theme: PluginTheme;
  providers: readonly ProviderChoice[];
  opened: ProviderChoice | null;
  value: string;
  marksProviderOfValue?: boolean;
  onOpen(provider: string): void;
  onPick(value: string): void;
  children?: ReactNode;
}) {
  return (
    <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ paddingVertical: 4 }}>
      {opened == null ? (
        <>
          {children}
          {providers.map((choice) => {
            const held = marksProviderOfValue ? choice.models.find((model) => model.value === value) : undefined;
            const count = choice.models.length;
            return (
              <MenuItem
                key={choice.provider}
                theme={theme}
                label={choice.label}
                hint={held?.modelLabel ?? `${count} ${count === 1 ? "model" : "models"}`}
                checked={marksProviderOfValue ? held != null : undefined}
                trailing="ChevronRight"
                onPress={() => onOpen(choice.provider)}
              />
            );
          })}
        </>
      ) : (
        opened.models.map((model) => (
          <MenuItem
            key={model.value}
            theme={theme}
            label={model.modelLabel}
            checked={model.value === value}
            onPress={() => onPick(model.value)}
          />
        ))
      )}
    </ScrollView>
  );
}

export function ModelMenu({
  theme,
  name = "Model",
  value,
  unset = "automatic",
  field,
  bounds,
  open,
  onOpenChange,
  onPick,
}: {
  theme: PluginTheme;
  name?: string;
  /** `provider/model`; empty is `unset`. */
  value: string;
  unset?: "automatic" | "none";
  /** A form control's look, with a label naming the provider. */
  field?: { disabled: boolean };
  bounds: RefObject<View | null>;
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(value: string): void;
}) {
  const query = useProviders();
  const entries = query.data?.entries ?? [];
  const providers = providerChoices(entries);
  const choices = modelChoices(entries);
  const chosen = choices.find((choice) => choice.value === value);
  const unsetLabel = unset === "automatic" ? "Automatic" : "None";
  const unsetHint = unset === "automatic" ? automaticChoice(choices)?.label : undefined;
  const unsetText = field != null && unsetHint != null ? `${unsetLabel} (${unsetHint})` : unsetLabel;
  const chosenText = (field != null ? chosen?.label : chosen?.modelLabel) ?? value;
  const label = value === "" ? unsetText : chosenText;
  return (
    <Dropdown
      theme={theme}
      label={label}
      accessibilityLabel={`${name}: ${label}`}
      icon="Sparkles"
      field={field}
      bounds={bounds}
      open={open}
      onOpenChange={(next) => {
        // Default cancels a first fetch still waiting on discovery, restarting its wait.
        if (next) void query.refetch({ cancelRefetch: false });
        onOpenChange(next);
      }}
    >
      <ModelList
        theme={theme}
        providers={providers}
        value={value}
        unsetLabel={unsetLabel}
        unsetHint={unsetHint}
        // A cached empty list may predate a provider becoming ready.
        finding={query.isPending || (query.isFetching && providers.length === 0)}
        onPick={onPick}
      />
    </Dropdown>
  );
}

function ModelList({
  theme,
  providers,
  value,
  unsetLabel,
  unsetHint,
  finding,
  onPick,
}: {
  theme: PluginTheme;
  providers: readonly ProviderChoice[];
  value: string;
  unsetLabel: string;
  unsetHint: string | undefined;
  finding: boolean;
  onPick(value: string): void;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const provider = providers.find((choice) => choice.provider === opened) ?? null;
  return (
    <>
      {provider == null ? null : (
        <BrowserBack
          theme={theme}
          title={provider.label}
          accessibilityLabel="Back to the providers"
          onPress={() => setOpened(null)}
        />
      )}
      <ModelOptions
        theme={theme}
        providers={providers}
        opened={provider}
        value={value}
        marksProviderOfValue
        onOpen={setOpened}
        onPick={onPick}
      >
        <MenuItem
          theme={theme}
          label={unsetLabel}
          hint={unsetHint}
          checked={value === ""}
          onPress={() => onPick("")}
        />
        <MenuSeparator theme={theme} />
        {providers.length > 0 ? null : (
          <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted, paddingHorizontal: 12, paddingVertical: 4 }}>
            {finding ? "Finding the available models…" : "No agent provider is ready."}
          </Text>
        )}
      </ModelOptions>
    </>
  );
}
