import type { MermaidDiff, MermaidDraw, MermaidOutcome } from "../../shared/protocol";

export type MermaidJob = ({ readonly kind: "diff" } & MermaidDiff) | ({ readonly kind: "draw" } & MermaidDraw);

export type MermaidRequest = MermaidJob & { readonly id: number };

export interface MermaidResponse {
  readonly id: number;
  readonly outcome: MermaidOutcome;
}
