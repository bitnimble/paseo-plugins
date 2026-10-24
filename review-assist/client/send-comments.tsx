import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsRow, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { isEdit } from "../shared/comments";
import { type AgentForm, type AgentPicks, type ProviderChoice, agentForm } from "../shared/models";
import { type AgentChoice, type Reviewer, agentsRpc } from "../shared/protocol";
import { Button, ToolbarTrigger } from "./controls";
import { MenuItem } from "./menu";
import { useProviders } from "./settings";
import type { Review } from "./use-review";

const DEFAULT_PICKS: AgentPicks = { model: null, mode: null, thinking: null };

export function SendComments({ theme, workspaceId, review }: { theme: PluginTheme; workspaceId: string; review: Review }) {
  const toast = useToast();
  const listAgents = useRpc(agentsRpc);
  const [open, setOpen] = useState(false);
  const agents = useQuery({
    queryKey: ["review-agents", workspaceId],
    queryFn: () => listAgents({ workspaceId }),
    enabled: open,
  });
  const choices = agents.data?.agents ?? [];
  // A cached empty list may predate an agent started since; trusting it would start a second one.
  const findingAgents = agents.isPending || (agents.isFetching && choices.length === 0);
  const startsAgent = !findingAgents && choices.length === 0;
  const providers = useProviders(open && startsAgent);
  const [picked, setPicked] = useState<string | null>(null);
  const [picks, setPicks] = useState(DEFAULT_PICKS);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const count = review.state.comments.length;
  const comments = `${count} ${count === 1 ? "comment" : "comments"}`;
  const edits = review.state.comments.filter(isEdit).length;
  const onlyEdits = edits === count;
  const chosen = choices.find(({ id }) => id === picked) ?? choices[0] ?? null;
  const form = agentForm(providers.data?.entries ?? [], picks);
  const reviewer = pickReviewer(chosen, startsAgent ? form : null, workspaceId);
  const muted = mutedText(theme);

  const send = async (to: Reviewer | null, done: string): Promise<void> => {
    setSending(true);
    const failure = await review.submit({ reviewer: to, message });
    setSending(false);
    if (failure != null) {
      toast.error(failure);
      return;
    }
    toast.show(done, { variant: "success" });
    setMessage("");
    setOpen(false);
  };

  if (onlyEdits) {
    const label = `Make ${count} suggested ${count === 1 ? "edit" : "edits"}`;
    return (
      <ToolbarTrigger
        theme={theme}
        label={label}
        icon="FilePen"
        onPress={() => {
          if (!sending) void send(null, `Made ${count === 1 ? "the suggested edit" : `${count} suggested edits`}`);
        }}
      />
    );
  }

  return (
    <>
      <ToolbarTrigger theme={theme} label={comments} icon="MessageSquare" onPress={() => setOpen(true)} />
      <Modal title={`Send ${comments}`} open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <Text style={muted}>
            The agent gets them as a review, the way the Changes panel sends comments, and they are cleared here.
            {edits === 0 ? "" : ` ${edits === 1 ? "The suggested edit is" : `The ${edits} suggested edits are`} made first, without the agent.`}
          </Text>
          <View style={{ gap: 2 }}>
            {findingAgents ? (
              <Text style={muted}>Finding this workspace's agents…</Text>
            ) : startsAgent ? (
              <NewAgent theme={theme} form={form} picks={picks} onPicks={setPicks} loading={providers.isPending} />
            ) : (
              choices.map((agent) => (
                <MenuItem
                  key={agent.id}
                  theme={theme}
                  label={agent.title ?? "Untitled agent"}
                  hint={`${agent.provider} · ${agent.status}`}
                  checked={agent.id === chosen?.id}
                  onPress={() => setPicked(agent.id)}
                />
              ))
            )}
          </View>
          <TextInput
            accessibilityLabel="Message to send with the comments"
            multiline
            value={message}
            onChangeText={setMessage}
            placeholder="Add a message (optional)"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              minHeight: 72,
              padding: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.border,
              color: theme.colors.foreground,
              fontSize: 14,
              lineHeight: 20,
              textAlignVertical: "top",
            }}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button theme={theme} variant="ghost" label="Cancel" onPress={() => setOpen(false)} />
            <Button
              theme={theme}
              variant="default"
              icon="Send"
              label={sending ? "Sending…" : reviewer?.kind === "new" ? "Start agent and send" : "Send to agent"}
              disabled={reviewer == null || sending}
              onPress={() => {
                if (reviewer == null) return;
                const to = reviewer.kind === "new" ? "a new agent" : (chosen?.title ?? "the agent");
                void send(reviewer, `Sent ${comments} to ${to}`);
              }}
            />
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}

function pickReviewer(chosen: AgentChoice | null, newAgent: AgentForm | null, workspaceId: string): Reviewer | null {
  if (chosen != null) return { kind: "agent", id: chosen.id };
  if (newAgent?.config == null) return null;
  return { kind: "new", workspaceId, ...newAgent.config };
}

const mutedText = (theme: PluginTheme) => ({ fontSize: 14, lineHeight: 20, color: theme.colors.foregroundMuted });

function NewAgent({
  theme,
  form,
  picks,
  onPicks,
  loading,
}: {
  theme: PluginTheme;
  form: AgentForm;
  picks: AgentPicks;
  onPicks(picks: AgentPicks): void;
  loading: boolean;
}) {
  const [browsing, setBrowsing] = useState(false);
  const muted = mutedText(theme);
  if (form.config == null) {
    return <Text style={muted}>{loading ? "Finding the available models…" : "No agent provider is ready."}</Text>;
  }
  const model = form.config.model;
  if (browsing) {
    return (
      <ModelBrowser
        theme={theme}
        providers={form.providers}
        value={model}
        onPick={(picked) => {
          onPicks({ ...picks, model: picked });
          setBrowsing(false);
        }}
        onClose={() => setBrowsing(false)}
      />
    );
  }
  const modelLabel = form.choice?.label ?? model;
  const options = (items: AgentForm["modes"]): { value: string; label: string }[] =>
    items.map(({ id, label }) => ({ value: id, label }));
  return (
    <>
      <Text style={muted}>No agent in this workspace yet. Sending starts one with the comments.</Text>
      <SettingsCard>
        <SettingsRow label="Model">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Model: ${modelLabel}`}
            onPress={() => setBrowsing(true)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: pressed ? theme.colors.surface2 : "transparent",
            })}
          >
            <Text style={{ fontSize: 14, color: theme.colors.foreground }}>{modelLabel}</Text>
            <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        </SettingsRow>
        {form.config.modeId == null ? null : (
          <SettingsSelect
            label="Mode"
            value={form.config.modeId}
            options={options(form.modes)}
            onValueChange={(mode) => onPicks({ ...picks, mode })}
          />
        )}
        {form.config.thinkingOptionId == null ? null : (
          <SettingsSelect
            label="Thinking"
            value={form.config.thinkingOptionId}
            options={options(form.thinking)}
            onValueChange={(thinking) => onPicks({ ...picks, thinking })}
          />
        )}
      </SettingsCard>
    </>
  );
}

function ModelBrowser({
  theme,
  providers,
  value,
  onPick,
  onClose,
}: {
  theme: PluginTheme;
  providers: readonly ProviderChoice[];
  value: string;
  onPick(value: string): void;
  onClose(): void;
}) {
  const only = providers.length === 1 ? providers[0].provider : null;
  const [opened, setOpened] = useState(
    () => only ?? providers.find(({ models }) => models.some((model) => model.value === value))?.provider ?? null,
  );
  const provider = providers.find((choice) => choice.provider === opened) ?? null;
  const title = provider?.label ?? "Choose a provider";
  const leavesBrowser = provider == null || only != null;
  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={leavesBrowser ? "Back to the agent options" : "Back to the providers"}
        onPress={leavesBrowser ? onClose : () => setOpened(null)}
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
      <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ paddingVertical: 4 }}>
        {provider == null
          ? providers.map((choice) => (
              <MenuItem
                key={choice.provider}
                theme={theme}
                label={choice.label}
                hint={`${choice.models.length} ${choice.models.length === 1 ? "model" : "models"}`}
                trailing="ChevronRight"
                onPress={() => setOpened(choice.provider)}
              />
            ))
          : provider.models.map((model) => (
              <MenuItem
                key={model.value}
                theme={theme}
                label={model.modelLabel}
                checked={model.value === value}
                onPress={() => onPick(model.value)}
              />
            ))}
      </ScrollView>
    </View>
  );
}
