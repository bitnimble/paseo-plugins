import type { MermaidDraw, MermaidOutcome } from "../../shared/protocol";

export interface MermaidRequest extends MermaidDraw {
  readonly id: number;
}

export interface MermaidResponse {
  readonly id: number;
  readonly outcome: MermaidOutcome;
}
