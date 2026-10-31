import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { type RefObject, useState } from "react";
import { Text, type View } from "react-native";
import {
  DEFAULT_BRANCH_MODE,
  type DiffBase,
  type DiffMode,
  UNCOMMITTED_MODE,
  branchesRpc,
  modeKey,
} from "../shared/protocol";
import { Dropdown, MenuHeading, MenuItem, MenuSeparator } from "./menu";

const SHOWN_BRANCHES = 8;

export function ModeMenu({
  theme,
  directory,
  mode,
  base,
  bounds,
  open,
  onOpenChange,
  onPick,
}: {
  theme: PluginTheme;
  directory: string;
  mode: DiffMode;
  /** The live diff's base, once it has loaded for `mode`. */
  base: DiffBase | null;
  bounds: RefObject<View | null>;
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(mode: DiffMode): void;
}) {
  const { data } = useBranches(directory);
  const defaultLabel = `vs ${data?.defaultBranch ?? "default branch"}`;
  const label =
    mode.kind === "uncommitted"
      ? "Uncommitted"
      : base != null
        ? `vs ${base.label}`
        : mode.branch == null
          ? defaultLabel
          : `vs ${mode.branch}`;
  return (
    <Dropdown theme={theme} label={label} bounds={bounds} open={open} onOpenChange={onOpenChange}>
      <MenuItem
        theme={theme}
        label={defaultLabel}
        hint="Everything since the branch point, uncommitted included"
        checked={modeKey(mode) === modeKey(DEFAULT_BRANCH_MODE)}
        onPress={() => onPick(DEFAULT_BRANCH_MODE)}
      />
      <MenuItem
        theme={theme}
        label="Uncommitted"
        hint="Working tree against HEAD"
        checked={mode.kind === "uncommitted"}
        onPress={() => onPick(UNCOMMITTED_MODE)}
      />
      <MenuSeparator theme={theme} />
      <MenuHeading theme={theme}>Compare with another branch</MenuHeading>
      <BranchPicker theme={theme} directory={directory} mode={mode} onPick={onPick} />
    </Dropdown>
  );
}

function BranchPicker({
  theme,
  directory,
  mode,
  onPick,
}: {
  theme: PluginTheme;
  directory: string;
  mode: DiffMode;
  onPick(mode: DiffMode): void;
}) {
  const [filter, setFilter] = useState("");
  const { data, error } = useBranches(directory);
  const needle = filter.trim().toLowerCase();
  const matches = (data?.branches ?? []).filter(
    (name) => name !== data?.defaultBranch && name.toLowerCase().includes(needle),
  );
  const muted = { fontSize: 12, color: theme.colors.foregroundMuted, paddingHorizontal: 12, paddingVertical: 4 };
  return (
    <>
      <TextInput
        accessibilityLabel="Filter branches"
        autoFocus
        value={filter}
        onChangeText={setFilter}
        placeholder="Filter branches"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          marginHorizontal: 8,
          marginVertical: 4,
          paddingHorizontal: 8,
          paddingVertical: 6,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          color: theme.colors.foreground,
          fontSize: 14,
        }}
      />
      {error != null ? (
        <Text style={{ ...muted, color: theme.colors.statusDanger }}>{error.message}</Text>
      ) : data == null ? (
        <Text style={muted}>Loading branches…</Text>
      ) : matches.length === 0 ? (
        <Text style={muted}>No matching branches</Text>
      ) : null}
      {matches.slice(0, SHOWN_BRANCHES).map((name) => (
        <MenuItem
          key={name}
          theme={theme}
          label={name}
          checked={mode.kind === "branch" && mode.branch === name}
          onPress={() => onPick({ kind: "branch", branch: name })}
        />
      ))}
      {matches.length > SHOWN_BRANCHES ? (
        <Text style={muted}>{matches.length - SHOWN_BRANCHES} more, filter to find them</Text>
      ) : null}
    </>
  );
}

function useBranches(directory: string): UseQueryResult<{ defaultBranch: string | null; branches: string[] }> {
  const readBranches = useRpc(branchesRpc);
  return useQuery({ queryKey: ["review-branches", directory], queryFn: () => readBranches({ directory }) });
}
