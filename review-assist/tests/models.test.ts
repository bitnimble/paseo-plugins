import assert from "node:assert/strict";
import test from "node:test";
import { type ProviderEntry, automaticChoice, modelChoices } from "../shared/models";

const provider = (
  name: string,
  ids: readonly string[],
  options: { status?: string; enabled?: boolean; unselectable?: readonly string[] } = {},
): ProviderEntry => ({
  provider: name,
  status: options.status ?? "ready",
  enabled: options.enabled,
  models: ids.map((id, i) => ({
    id,
    label: id,
    isDefault: i === 0,
    isSelectable: !(options.unselectable ?? []).includes(id),
  })),
});

const automatic = (entries: readonly ProviderEntry[]): string | null => automaticChoice(modelChoices(entries))?.value ?? null;

const CODEX = provider("codex", ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
const CLAUDE_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

test("Automatic prefers Haiku, then Sonnet, then their OpenAI tiers, then the first provider's default", () => {
  assert.equal(automatic([CODEX, provider("claude", CLAUDE_IDS)]), "claude/claude-haiku-5-5");
  assert.equal(automatic([CODEX, provider("claude", ["claude-opus-5-5", "claude-sonnet-5-5"])]), "claude/claude-sonnet-5-5");
  assert.equal(automatic([CODEX]), "codex/gpt-6-luna");
  assert.equal(automatic([provider("codex", ["gpt-6-astra", "gpt-6-sol"])]), "codex/gpt-6-sol");
  assert.equal(automatic([provider("other", ["big", "small"])]), "other/big");
  assert.equal(automatic([]), null);
});

test("Automatic skips providers that are not ready or are disabled, and models that cannot be picked", () => {
  assert.equal(automatic([CODEX, provider("claude", CLAUDE_IDS, { status: "error" })]), "codex/gpt-6-luna");
  assert.equal(automatic([CODEX, provider("claude", CLAUDE_IDS, { enabled: false })]), "codex/gpt-6-luna");
  assert.equal(
    automatic([CODEX, provider("claude", CLAUDE_IDS, { unselectable: ["claude-haiku-5-5"] })]),
    "claude/claude-sonnet-5-5",
  );
});

test("a preferred model several providers offer comes from the first of them", () => {
  assert.equal(
    automatic([provider("claude", CLAUDE_IDS), provider("claude-briefcase", CLAUDE_IDS)]),
    "claude/claude-haiku-5-5",
  );
});
