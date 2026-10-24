interface Option {
  readonly id: string;
  readonly label: string;
  readonly isDefault?: boolean;
}

export interface ProviderEntry {
  readonly provider: string;
  readonly label?: string;
  readonly status: string;
  readonly enabled?: boolean;
  readonly modes?: readonly Option[];
  readonly defaultModeId?: string | null;
  readonly models?: readonly (Option & {
    readonly isSelectable?: boolean;
    readonly thinkingOptions?: readonly Option[];
    readonly defaultThinkingOptionId?: string;
  })[];
}

/** What the user picked for a new agent; null keeps the default. */
export interface AgentPicks {
  readonly model: string | null;
  readonly mode: string | null;
  readonly thinking: string | null;
}

export interface AgentForm {
  readonly providers: readonly ProviderChoice[];
  readonly choice: ModelChoice | null;
  readonly modes: readonly Option[];
  readonly thinking: readonly Option[];
  /** Null while no ready provider offers a model. */
  readonly config: { readonly model: string; readonly modeId: string | null; readonly thinkingOptionId: string | null } | null;
}

/** The choices for a new agent, with picks the chosen model no longer offers falling back to its defaults. */
export function agentForm(entries: readonly ProviderEntry[], picks: AgentPicks): AgentForm {
  const providers = providerChoices(entries);
  const models = providers.flatMap((provider) => provider.models);
  const choice = models.find(({ value }) => value === picks.model) ?? models[0];
  if (choice == null) return { providers, choice: null, modes: [], thinking: [], config: null };
  const entry = entries.find(({ provider }) => provider === choice.provider);
  const model = entry?.models?.find(({ id }) => id === choice.model);
  const modes = entry?.modes ?? [];
  const thinking = model?.thinkingOptions ?? [];
  const offered = (options: readonly Option[], pick: string | null, fallback: string | null | undefined): string | null =>
    options.some(({ id }) => id === pick) ? pick : (fallback ?? options[0]?.id ?? null);
  return {
    providers,
    choice,
    modes,
    thinking,
    config: {
      model: choice.value,
      modeId: offered(modes, picks.mode, entry?.defaultModeId),
      thinkingOptionId: offered(
        thinking,
        picks.thinking,
        model?.defaultThinkingOptionId ?? thinking.find(({ isDefault }) => isDefault === true)?.id,
      ),
    },
  };
}

export interface ModelChoice {
  /** `provider/model`. */
  readonly value: string;
  /** With the provider's name, for a flat list of every provider's models. */
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly modelLabel: string;
}

export interface ProviderChoice {
  readonly provider: string;
  readonly label: string;
  readonly models: readonly ModelChoice[];
}

const AUTOMATIC_PREFERENCE: readonly string[] = ["claude-haiku-5-5", "claude-sonnet-5-5", "gpt-6-luna", "gpt-6-sol"];

/** Ready providers with selectable models, each provider's default model first. */
export function providerChoices(entries: readonly ProviderEntry[]): ProviderChoice[] {
  return entries
    .filter((entry) => entry.enabled !== false && entry.status === "ready")
    .map((entry) => {
      const label = entry.label ?? entry.provider;
      const models = [...(entry.models ?? [])]
        .filter((model) => model.isSelectable !== false)
        .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true))
        .map((model) => ({
          value: `${entry.provider}/${model.id}`,
          label: `${label} · ${model.label}`,
          provider: entry.provider,
          model: model.id,
          modelLabel: model.label,
        }));
      return { provider: entry.provider, label, models };
    })
    .filter(({ models }) => models.length > 0);
}

export function modelChoices(entries: readonly ProviderEntry[]): ModelChoice[] {
  return providerChoices(entries).flatMap(({ models }) => models);
}

/** What "Automatic" runs: the first preferred model any ready provider offers, else the first choice. */
export function automaticChoice(choices: readonly ModelChoice[]): ModelChoice | null {
  for (const model of AUTOMATIC_PREFERENCE) {
    const choice = choices.find((candidate) => candidate.model === model);
    if (choice != null) return choice;
  }
  return choices[0] ?? null;
}
