export interface ProviderEntry {
  readonly provider: string;
  readonly label?: string;
  readonly status: string;
  readonly enabled?: boolean;
  readonly models?: readonly {
    readonly id: string;
    readonly label: string;
    readonly isDefault?: boolean;
    readonly isSelectable?: boolean;
  }[];
}

export interface ModelChoice {
  readonly value: string;
  readonly label: string;
  readonly model: string;
}

const AUTOMATIC_PREFERENCE: readonly string[] = ["claude-haiku-5-5", "claude-sonnet-5-5", "gpt-6-luna", "gpt-6-sol"];

/** Selectable `provider/model` values of ready providers, each provider's default model first. */
export function modelChoices(entries: readonly ProviderEntry[]): ModelChoice[] {
  return entries
    .filter((entry) => entry.enabled !== false && entry.status === "ready")
    .flatMap((entry) =>
      [...(entry.models ?? [])]
        .filter((model) => model.isSelectable !== false)
        .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true))
        .map((model) => ({
          value: `${entry.provider}/${model.id}`,
          label: `${entry.label ?? entry.provider} · ${model.label}`,
          model: model.id,
        })),
    );
}

/** What "Automatic" runs: the first preferred model any ready provider offers, else the first choice. */
export function automaticChoice(choices: readonly ModelChoice[]): ModelChoice | null {
  for (const model of AUTOMATIC_PREFERENCE) {
    const choice = choices.find((candidate) => candidate.model === model);
    if (choice != null) return choice;
  }
  return choices[0] ?? null;
}
