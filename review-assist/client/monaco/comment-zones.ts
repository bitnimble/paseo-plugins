import { createZoneNode } from "../web";
import type { CodeEditor, ViewZone } from "./api";

export interface ZoneSpec {
  readonly key: string;
  readonly editor: CodeEditor;
  readonly afterLine: number;
  readonly ordinal: number;
  readonly height: number;
}

interface PlacedZone {
  spec: ZoneSpec;
  readonly id: string;
  readonly zone: ViewZone;
}

export class CommentZones {
  private readonly placed = new Map<string, PlacedZone>();

  constructor(private readonly onTop: (key: string, top: number) => void) {}

  sync(specs: readonly ZoneSpec[]): void {
    const wanted = new Map(specs.map((spec) => [spec.key, spec]));
    for (const [key, placed] of this.placed) {
      const next = wanted.get(key);
      const { spec } = placed;
      if (next == null || next.editor !== spec.editor || next.afterLine !== spec.afterLine || next.ordinal !== spec.ordinal) {
        spec.editor.changeViewZones((zones) => zones.removeZone(placed.id));
        this.placed.delete(key);
      } else if (next.height !== spec.height) {
        placed.spec = next;
        placed.zone.heightInPx = next.height;
        spec.editor.changeViewZones((zones) => zones.layoutZone(placed.id));
      }
    }
    for (const spec of specs) {
      if (this.placed.has(spec.key)) continue;
      const zone: ViewZone = {
        afterLineNumber: spec.afterLine,
        heightInPx: spec.height,
        ordinal: spec.ordinal,
        domNode: createZoneNode(),
        suppressMouseDown: true,
        // A comment on a line folded into "N hidden lines" would otherwise never be drawn.
        showInHiddenAreas: true,
        onDomNodeTop: (top) => this.onTop(spec.key, top),
      };
      spec.editor.changeViewZones((zones) => {
        this.placed.set(spec.key, { spec, id: zones.addZone(zone), zone });
      });
    }
  }

  clear(): void {
    this.sync([]);
  }
}
