import assert from "node:assert/strict";
import test from "node:test";
import {
  type ProviderEntry,
  agentForm,
  automaticChoice,
  modelChoices,
  modelsToTry,
  providerChoices,
} from "../shared/models";

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

test("a new agent starts on the first provider's default model, mode and thinking, keeping picks it offers", () => {
  const claude: ProviderEntry = {
    provider: "claude",
    status: "ready",
    modes: [
      { id: "default", label: "Default" },
      { id: "plan", label: "Plan" },
    ],
    defaultModeId: "default",
    models: [
      { id: "opus", label: "Opus", thinkingOptions: [{ id: "low", label: "Low" }, { id: "high", label: "High", isDefault: true }] },
      { id: "haiku", label: "Haiku", isDefault: true },
    ],
  };
  const none = { model: null, mode: null, thinking: null };
  assert.deepEqual(agentForm([CODEX, claude], none).config, { model: "codex/gpt-6-astra", modeId: null, thinkingOptionId: null });
  assert.deepEqual(agentForm([claude], { ...none, model: "claude/opus" }).config, {
    model: "claude/opus",
    modeId: "default",
    thinkingOptionId: "high",
  });
  assert.deepEqual(agentForm([claude], { model: "claude/opus", mode: "plan", thinking: "low" }).config, {
    model: "claude/opus",
    modeId: "plan",
    thinkingOptionId: "low",
  });
  assert.deepEqual(agentForm([claude], { model: "claude/haiku", mode: "plan", thinking: "low" }).config, {
    model: "claude/haiku",
    modeId: "plan",
    thinkingOptionId: null,
  });
  assert.deepEqual(agentForm([claude], { ...none, model: "gone/model" }).config?.model, "claude/haiku");
  assert.equal(agentForm([], none).config, null);
});

test("models group under their ready provider, which is left out with none to pick", () => {
  const providers = providerChoices([
    { ...CODEX, label: "Codex" },
    provider("claude", ["claude-opus-5-5"], { status: "error" }),
    provider("empty", ["only"], { unselectable: ["only"] }),
  ]);
  assert.deepEqual(
    providers.map(({ provider, label, models }) => [provider, label, models.map(({ value, modelLabel }) => [value, modelLabel])]),
    [["codex", "Codex", [["codex/gpt-6-astra", "gpt-6-astra"], ["codex/gpt-6-sol", "gpt-6-sol"], ["codex/gpt-6-luna", "gpt-6-luna"]]]],
  );
});

test("the configured model runs first, then the backup, both only if a ready provider offers them", () => {
  const down = provider("claude", CLAUDE_IDS, { status: "error" });
  assert.deepEqual(modelsToTry([CODEX, provider("claude", CLAUDE_IDS)], " claude/claude-opus-5-5 ", " codex/gpt-6-sol "), [
    "claude/claude-opus-5-5",
    "codex/gpt-6-sol",
  ]);
  assert.deepEqual(modelsToTry([CODEX, down], "claude/claude-opus-5-5", "codex/gpt-6-sol"), ["codex/gpt-6-sol"]);
  assert.deepEqual(modelsToTry([CODEX, down], "codex/gpt-6-sol", "claude/claude-opus-5-5"), ["codex/gpt-6-sol"]);
});

test("with neither model offered both are tried, so an uncatalogued one still gets its provider's error", () => {
  assert.deepEqual(modelsToTry([CODEX], "other/one", "other/two"), ["other/one", "other/two"]);
  assert.deepEqual(modelsToTry([], "other/one", ""), ["other/one"]);
});

test("Automatic resolves before the backup, a duplicate runs once, and nothing to run gives no models", () => {
  assert.deepEqual(modelsToTry([CODEX], "", "codex/gpt-6-sol"), ["codex/gpt-6-luna", "codex/gpt-6-sol"]);
  assert.deepEqual(modelsToTry([CODEX], "codex/gpt-6-sol", " codex/gpt-6-sol"), ["codex/gpt-6-sol"]);
  assert.deepEqual(modelsToTry([CODEX], "", "codex/gpt-6-luna"), ["codex/gpt-6-luna"]);
  assert.deepEqual(modelsToTry([CODEX], "  ", "gone/model"), ["codex/gpt-6-luna"]);
  assert.deepEqual(modelsToTry([], "", ""), []);
  assert.deepEqual(modelsToTry([], "", "other/two"), ["other/two"]);
});

test("a preferred model several providers offer comes from the first of them", () => {
  assert.equal(
    automatic([provider("claude", CLAUDE_IDS), provider("claude-briefcase", CLAUDE_IDS)]),
    "claude/claude-haiku-5-5",
  );
});
