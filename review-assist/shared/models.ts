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
}

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
        })),
    );
}
