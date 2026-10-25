import type { DiffFile } from "../shared/diff";
import { MERMAID_DEFAULT_DISTANCE } from "../shared/protocol";

export type VisualView =
  | { readonly kind: "mermaid"; readonly visual: boolean; readonly distance: number }
  | { readonly kind: "markdown"; readonly visual: boolean };

// Shared, so memoised file rows see the same view on every render.
const MERMAID_VIEW: VisualView = { kind: "mermaid", visual: true, distance: MERMAID_DEFAULT_DISTANCE };
const MARKDOWN_VIEW: VisualView = { kind: "markdown", visual: false };

/** Null for files without a rendered diff. */
export function defaultVisualView(file: DiffFile): VisualView | null {
  if (file.binary || file.lfs || file.hunks.length === 0) return null;
  if (/\.(?:mmd|mermaid)$/i.test(file.path)) return MERMAID_VIEW;
  if (/\.(?:md|markdown)$/i.test(file.path)) return MARKDOWN_VIEW;
  return null;
}
