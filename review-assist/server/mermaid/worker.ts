import { FONT_FAMILY, FONT_SIZE, document, font } from "./shim";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import mermaid from "mermaid";
import { parentPort } from "node:worker_threads";
import { messageOf } from "../../shared/errors";
import type { MermaidOutcome, MermaidPalette } from "../../shared/protocol";
import { type Diagram, diffDiagrams, diffSource } from "./diagram";
import type { MermaidRequest, MermaidResponse } from "./messages";
import { paintDiff } from "./paint";
import { edgeDomIds, readDiagram } from "./read-diagram";

const PNG_SCALE = 2;
const FONT_FACE = `<style>@font-face{font-family:"${FONT_FAMILY}";src:url(data:font/ttf;base64,${Buffer.from(font).toString("base64")})}</style>`;

const rasterizer = initWasm(wasm);
let renders = 0;
let queue = Promise.resolve();

parentPort?.on("message", (request: MermaidRequest) => {
  // One at a time: renders share the one document.
  queue = queue.then(async () => {
    const outcome = await drawDiff(request).catch((error: unknown) => unavailable(messageOf(error)));
    parentPort?.postMessage({ id: request.id, outcome } satisfies MermaidResponse);
  });
});

async function drawDiff({ before, after, format, palette, distance }: MermaidRequest): Promise<MermaidOutcome> {
  mermaid.initialize(mermaidConfig(palette));
  const [old, current] = await Promise.all([parse(before, "before"), parse(after, "after")]);
  if (typeof old === "string") return unavailable(old);
  if (typeof current === "string") return unavailable(current);
  const either = current ?? old;
  if (either == null) return unavailable("Both sides are empty.");
  if (old != null && current != null && old.kind !== current.kind) return unavailable("The diagram changed kind.");
  const diff = diffDiagrams(old ?? emptyDiagram(either), current ?? emptyDiagram(either), distance);
  if (diff == null) return unavailable("No node, link or group changed.");

  const source = diffSource(diff);
  const union = await mermaid.mermaidAPI.getDiagramFromText(source);
  const svgId = `review-mermaid-${renders++}`;
  const host = document.createElement("div");
  host.innerHTML = (await mermaid.render(svgId, source)).svg;
  const svg = host.firstChild;
  if (svg == null) return unavailable("Mermaid drew nothing.");
  paintDiff(svg, svgId, diff, edgeDomIds(union.type, union.db), palette, document);
  const [, , width, height] = (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
  if (!(width > 0 && height > 0)) return unavailable("Mermaid drew nothing.");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("style", "");
  const markup = host.innerHTML;
  const drawn = { status: "ready", width, height, truncated: diff.truncated } as const;
  if (format === "svg") {
    const withFont = markup.replace(/^<svg[^>]*>/, (tag) => `${tag}${FONT_FACE}`);
    return { ...drawn, uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withFont)}` };
  }
  await rasterizer;
  const png = new Resvg(markup, {
    fitTo: { mode: "zoom", value: PNG_SCALE },
    background: palette.background,
    font: { fontBuffers: [font], defaultFontFamily: FONT_FAMILY, loadSystemFonts: false },
  })
    .render()
    .asPng();
  return { ...drawn, uri: `data:image/png;base64,${Buffer.from(png).toString("base64")}` };
}

/** A string explains why the side can't be drawn; null is an empty side. */
async function parse(text: string, side: "before" | "after"): Promise<Diagram | string | null> {
  if (text.trim() === "") return null;
  try {
    const parsed = await mermaid.mermaidAPI.getDiagramFromText(text);
    return readDiagram(parsed.type, parsed.db) ?? "Visual diffs draw flowcharts and class diagrams.";
  } catch (error) {
    return `The diagram ${side} this change doesn't parse: ${messageOf(error)}`;
  }
}

function emptyDiagram({ kind, direction }: Diagram): Diagram {
  return { kind, direction, nodes: [], edges: [], groups: [] };
}

function unavailable(reason: string): MermaidOutcome {
  return { status: "unavailable", reason };
}

function mermaidConfig(palette: MermaidPalette): Parameters<typeof mermaid.initialize>[0] {
  return {
    startOnLoad: false,
    // "strict" sanitizes labels with DOMPurify, which needs a real DOM.
    securityLevel: "loose",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    fontFamily: FONT_FAMILY,
    theme: "base",
    themeVariables: {
      darkMode: palette.dark,
      fontFamily: FONT_FAMILY,
      fontSize: `${FONT_SIZE}px`,
      background: palette.background,
      primaryColor: palette.surface,
      primaryTextColor: palette.foreground,
      primaryBorderColor: palette.border,
      secondaryColor: palette.surface,
      tertiaryColor: palette.background,
      mainBkg: palette.surface,
      nodeBorder: palette.border,
      clusterBkg: palette.background,
      clusterBorder: palette.border,
      lineColor: palette.muted,
      textColor: palette.foreground,
      titleColor: palette.foreground,
      edgeLabelBackground: palette.background,
      // Mermaid's default light drop shadow reads as a thick border on dark palettes.
      dropShadow: "none",
    },
  };
}
