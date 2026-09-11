import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList, Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { listFilesRpc } from "../shared/protocol";

const MAX_RESULTS = 200;

export function FilePicker({
  workspaceId,
  theme,
  open,
  onOpenChange,
  onSelect,
}: {
  workspaceId: string;
  theme: PluginTheme;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSelect(path: string): void;
}) {
  const listFiles = useRpc(listFilesRpc);
  const [filter, setFilter] = useState("");

  const files = useQuery({
    queryKey: ["monaco", "files", workspaceId],
    queryFn: async () => await listFiles({ workspaceId }),
    enabled: open,
    staleTime: 30_000,
  });

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = files.data?.files ?? [];
    const filtered = needle.length === 0 ? all : all.filter((path) => path.toLowerCase().includes(needle));
    return filtered.slice(0, MAX_RESULTS);
  }, [files.data, filter]);

  return (
    <Modal
      title="Open file"
      icon={<Icon name="FileCode" size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 16, gap: 12 }}>
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder="Filter by path"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoFocus
          style={{
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            color: theme.colors.foreground,
            backgroundColor: theme.colors.surface1,
          }}
        />
        {files.isError ? (
          <Text style={{ color: theme.colors.statusDanger }}>{String(files.error)}</Text>
        ) : null}
        <FlatList
          style={{ flex: 1, minHeight: 0 }}
          data={matches}
          keyExtractor={(path) => path}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onSelect(item);
                onOpenChange(false);
              }}
            >
              <View style={{ paddingVertical: 8, paddingHorizontal: 4 }}>
                <Text style={{ color: theme.colors.foreground }} numberOfLines={1}>
                  {item}
                </Text>
              </View>
            </Pressable>
          )}
        />
      </Modal.Content>
    </Modal>
  );
}
