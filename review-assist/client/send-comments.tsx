import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { isEdit } from "../shared/comments";
import { agentsRpc } from "../shared/protocol";
import { Button, ToolbarTrigger } from "./controls";
import { MenuItem } from "./menu";
import type { Review } from "./use-review";

export function SendComments({ theme, workspaceId, review }: { theme: PluginTheme; workspaceId: string; review: Review }) {
  const toast = useToast();
  const listAgents = useRpc(agentsRpc);
  const [open, setOpen] = useState(false);
  const agents = useQuery({
    queryKey: ["review-agents", workspaceId],
    queryFn: () => listAgents({ workspaceId }),
    enabled: open,
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const count = review.state.comments.length;
  const comments = `${count} ${count === 1 ? "comment" : "comments"}`;
  const edits = review.state.comments.filter(isEdit).length;
  const onlyEdits = edits === count;
  const choices = agents.data?.agents ?? [];
  const chosen = choices.find(({ id }) => id === picked) ?? choices[0] ?? null;
  const muted = { fontSize: 14, lineHeight: 20, color: theme.colors.foregroundMuted };

  const send = async (agentId: string | null, done: string) => {
    setSending(true);
    const failure = await review.submit({ agentId, message });
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
            {agents.isPending ? (
              <Text style={muted}>Finding this workspace's agents…</Text>
            ) : choices.length === 0 ? (
              <Text style={muted}>No agent in this workspace yet. Start one, then send.</Text>
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
              label={sending ? "Sending…" : "Send to agent"}
              disabled={chosen == null || sending}
              onPress={() => {
                if (chosen != null) void send(chosen.id, `Sent ${comments} to ${chosen.title ?? "the agent"}`);
              }}
            />
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
