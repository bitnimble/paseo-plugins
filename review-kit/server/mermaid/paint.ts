import type { SvgDocument, SvgElement } from "svgdom";
import type { Change, Cut, DiagramDiff, Row, ShownNode } from "./diagram";

export interface DiagramColors {
  readonly background: string;
  readonly foreground: string;
  readonly added: string;
  readonly removed: string;
  readonly changed: string;
}

const FADED_OPACITY = "0.35";
const FILL_STRENGTH = 0.18;
const SHAPES = "rect, path, polygon, circle, ellipse, line";
const MARKER_ENDS = ["marker-start", "marker-end"];
const HOLLOW_MARKER = /\b(?:extension|aggregation|lollipop)\b/;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CUT_LENGTH = 28;
const SLASH_LEAN = 4;
const SLASH_REACH = 9;
const SLASH_GAP = 5;
const SHARED_START = SLASH_REACH + 4;
const DRAWING_PADDING = 8;

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Colors the rendered diff in place; `edgeIds` are the DOM ids, minus the SVG's id, of `diff.edges`
 * and then of the cuts' links.
 */
export function paintDiff(
  svg: SvgElement,
  svgId: string,
  diff: DiagramDiff,
  edgeIds: readonly string[],
  colors: DiagramColors,
  document: SvgDocument,
): void {
  const tone = (change: Change) => (change === "same" ? null : colors[change]);
  const shownById = new Map(diff.nodes.map((shown) => [shown.node.id, shown]));
  const placeholders = new Set(diff.cuts.map(({ placeholder }) => placeholder));
  const nodePrefix = new RegExp(`^${escapeRegExp(svgId)}-(?:flowchart|classId)-(.+)-\\d+$`);
  for (const element of [...svg.querySelectorAll("g.node")]) {
    const id = nodePrefix.exec(element.getAttribute("id") ?? "")?.[1] ?? "";
    if (placeholders.has(id)) element.parentNode?.removeChild(element);
    const shown = shownById.get(id);
    if (shown != null) paintNode(element, shown, colors);
  }

  const idsMatch = edgeIds.length === diff.edges.length + diff.cuts.length;
  const pathAt = (index: number) => (idsMatch ? svg.querySelector(`[id="${svgId}-${edgeIds[index]}"]`) : null);
  const linkEnds = diff.edges.flatMap((_, i) => {
    const points = linkPoints(pathAt(i));
    return points.length === 0 ? [] : [points[0], points[points.length - 1]];
  });
  diff.cuts.forEach((cut, i) => {
    const path = pathAt(diff.edges.length + i);
    if (path != null) drawCut(svg, path, cut, linkEnds, document);
  });
  if (diff.cuts.length > 0) cropToContent(svg);

  const markers = new Map<string, string>();
  const colorLink = (path: SvgElement, color: string) => {
    addStyle(path, `stroke:${color}`);
    for (const end of MARKER_ENDS) {
      const marker = /^url\(#(.+)\)$/.exec(path.getAttribute(end) ?? "")?.[1];
      if (marker != null) path.setAttribute(end, `url(#${tintedMarker(svg, markers, marker, color)})`);
    }
  };
  diff.edges.forEach(({ change, faded, label }, i) => {
    const id = idsMatch ? edgeIds[i] : null;
    const path = pathAt(i);
    const route = linkPoints(path);
    if (path != null && route.length >= 2) seatMarkers(svg, path, route[0], route[route.length - 1]);
    const edgeLabel = id == null ? null : svg.querySelector(`g.label[data-id="${id}"]`);
    const color = tone(change);
    // Not the label's background, which hides the link running under the text.
    for (const element of [path, ...(edgeLabel?.querySelectorAll("text") ?? [])]) {
      if (element != null && faded) element.setAttribute("opacity", FADED_OPACITY);
    }
    if (color == null) return;
    if (path != null) colorLink(path, color);
    for (const text of edgeLabel?.querySelectorAll("text") ?? []) paintText(text, label, color, colors);
  });

  // Mermaid numbers lollipops in the order the source declares them, which is this order.
  const lollipops = diff.nodes.flatMap(({ interfaces, faded }) => interfaces.map((row) => ({ ...row, faded })));
  const links = [...svg.querySelectorAll("path")];
  lollipops.forEach(({ text: interfaceName, change, faded }, n) => {
    const label = svg.querySelector(`[id="${svgId}-interface${n}"]`);
    const link = links.find((path) => (path.getAttribute("id") ?? "").startsWith(`${svgId}-id_interface${n}_`));
    for (const element of [label, link]) {
      if (element != null && faded) element.setAttribute("opacity", FADED_OPACITY);
    }
    const color = tone(change);
    if (color == null) return;
    if (link != null) colorLink(link, color);
    for (const text of label?.querySelectorAll("text") ?? []) paintText(text, [{ text: interfaceName, change }], color, colors);
  });

  for (const { group, change, title } of diff.groups) {
    const color = tone(change);
    const cluster = svg.querySelector(`[id="${svgId}-${group.id}"]`);
    if (color == null || cluster == null) continue;
    for (const rect of cluster.querySelectorAll("rect")) addStyle(rect, `stroke:${color}`);
    for (const text of cluster.querySelectorAll("text")) paintText(text, title, color, colors);
  }
}

/** Trims the link to its placeholder down to a stub off the node, ended by a double slash. */
function drawCut(svg: SvgElement, path: SvgElement, { incoming }: Cut, linkEnds: readonly Point[], document: SvgDocument): void {
  const points = linkPoints(path);
  if (points.length < 2) return;
  const [attached, next] = incoming ? [points[points.length - 1], points[points.length - 2]] : [points[0], points[1]];
  const size = Math.hypot(next.x - attached.x, next.y - attached.y) || 1;
  const along = { x: (next.x - attached.x) / size, y: (next.y - attached.y) / size };
  const across = { x: -along.y, y: along.x };
  let start = attached;
  // Slid along the node's edge clear of any link leaving close enough for the slash to cross it.
  for (const other of linkEnds) {
    const apart = { x: start.x - other.x, y: start.y - other.y };
    const offset = apart.x * across.x + apart.y * across.y;
    if (Math.abs(apart.x * along.x + apart.y * along.y) >= SHARED_START || Math.abs(offset) >= SHARED_START) continue;
    const slide = (offset < 0 ? -SHARED_START : SHARED_START) - offset;
    start = { x: start.x + across.x * slide, y: start.y + across.y * slide };
  }
  const end = { x: start.x + along.x * CUT_LENGTH, y: start.y + along.y * CUT_LENGTH };
  const [from, to] = incoming ? [end, start] : [start, end];
  path.setAttribute("d", `M${from.x},${from.y}L${to.x},${to.y}`);
  path.removeAttribute(incoming ? "marker-start" : "marker-end");
  seatMarkers(svg, path, from, to);
  path.setAttribute("opacity", FADED_OPACITY);
  path.setAttribute("class", `${path.getAttribute("class") ?? ""} review-cut`);

  // The link's own classes keep its thickness; a slash is always solid.
  const classes = `${(path.getAttribute("class") ?? "").replace(/\bedge-pattern-\w+/g, "")} edge-pattern-solid`;
  for (const back of [SLASH_GAP, 0]) {
    const tip = (sign: number): Point => ({
      x: end.x - along.x * back + sign * (along.x * SLASH_LEAN + across.x * SLASH_REACH),
      y: end.y - along.y * back + sign * (along.y * SLASH_LEAN + across.y * SLASH_REACH),
    });
    const [from, to] = [tip(-1), tip(1)];
    const slash = document.createElementNS(SVG_NAMESPACE, "line");
    for (const [name, value] of Object.entries({ x1: from.x, y1: from.y, x2: to.x, y2: to.y })) {
      slash.setAttribute(name, String(value));
    }
    slash.setAttribute("class", classes);
    slash.setAttribute("style", "fill:none");
    slash.setAttribute("opacity", FADED_OPACITY);
    path.parentNode?.appendChild(slash);
  }
}

/**
 * Moves a link's marked ends so each marker's tip meets the node at `start` or `end`: mermaid pulls
 * class diagram links back further than their markers reach, leaving the tips short of the box.
 */
function seatMarkers(svg: SvgElement, path: SvgElement, start: Point, end: Point): void {
  const d = path.getAttribute("d") ?? "";
  const pairs = [...d.matchAll(/(-?[\d.]+(?:e-?\d+)?)[\s,]+(-?[\d.]+(?:e-?\d+)?)/g)];
  if (pairs.length < 2) return;
  const pointOf = (pair: RegExpMatchArray): Point => ({ x: Number(pair[1]), y: Number(pair[2]) });
  const toward = (from: Point, to: Point, distance: number): Point => {
    const size = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: from.x + ((to.x - from.x) / size) * distance, y: from.y + ((to.y - from.y) / size) * distance };
  };
  const moves: { pair: RegExpMatchArray; point: Point }[] = [];
  const startReach = classMarkerReach(svg, path.getAttribute("marker-start"), "start");
  if (startReach != null) moves.push({ pair: pairs[0], point: toward(start, pointOf(pairs[1]), startReach) });
  const endReach = classMarkerReach(svg, path.getAttribute("marker-end"), "end");
  if (endReach != null) moves.push({ pair: pairs[pairs.length - 1], point: toward(end, pointOf(pairs[pairs.length - 2]), endReach) });
  let seated = d;
  for (const { pair, point } of moves.sort((a, b) => (b.pair.index ?? 0) - (a.pair.index ?? 0))) {
    const at = pair.index ?? 0;
    seated = `${seated.slice(0, at)}${point.x},${point.y}${seated.slice(at + pair[0].length)}`;
  }
  path.setAttribute("d", seated);
}

/** How far a class diagram marker's tip reaches past the link's end, or null for any other marker. */
function classMarkerReach(svg: SvgElement, reference: string | null, end: "start" | "end"): number | null {
  const id = /^url\(#(.+)\)$/.exec(reference ?? "")?.[1];
  const marker = id == null ? null : svg.querySelector(`[id="${id}"]`);
  if (marker == null || !/\bclassDiagram\b/.test(marker.getAttribute("class") ?? "")) return null;
  if (marker.getAttribute("markerUnits") !== "userSpaceOnUse") return null;
  const xs = [...marker.querySelectorAll("path, polygon, circle")].flatMap(shapeXs);
  if (xs.length === 0) return null;
  const [, , boxWidth, boxHeight] = (marker.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const width = Number(marker.getAttribute("markerWidth"));
  const height = Number(marker.getAttribute("markerHeight"));
  const scale = boxWidth > 0 && boxHeight > 0 && width > 0 && height > 0 ? Math.min(width / boxWidth, height / boxHeight) : 1;
  const refX = Number(marker.getAttribute("refX") ?? 0);
  return Math.max(0, (end === "start" ? refX - Math.min(...xs) : Math.max(...xs) - refX) * scale);
}

function shapeXs(shape: SvgElement): number[] {
  if (shape.nodeName === "circle") {
    const cx = Number(shape.getAttribute("cx"));
    const r = Number(shape.getAttribute("r"));
    return [cx - r, cx + r].filter(Number.isFinite);
  }
  const coordinates = shape.getAttribute(shape.nodeName === "polygon" ? "points" : "d") ?? "";
  return [...coordinates.matchAll(/(-?[\d.]+)[\s,]+(-?[\d.]+)/g)].map((pair) => Number(pair[1]));
}

/** Drops the room placeholders held past the drawing's edges, never widening it. */
function cropToContent(svg: SvgElement): void {
  const [x, y, width, height] = (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
  const content = svg.getBBox();
  if (![x, y, width, height, content.width, content.height].every(Number.isFinite) || content.width <= 0) return;
  const left = Math.max(x, content.x - DRAWING_PADDING);
  const top = Math.max(y, content.y - DRAWING_PADDING);
  const right = Math.min(x + width, content.x + content.width + DRAWING_PADDING);
  const bottom = Math.min(y + height, content.y + content.height + DRAWING_PADDING);
  svg.setAttribute("viewBox", `${left} ${top} ${right - left} ${bottom - top}`);
}

/** Mermaid records a link's route, from its start, base64-encoded. */
function linkPoints(path: SvgElement | null): Point[] {
  const encoded = path?.getAttribute("data-points");
  if (encoded == null) return [];
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((point: unknown) => {
      if (typeof point !== "object" || point == null) return [];
      const x: unknown = Reflect.get(point, "x");
      const y: unknown = Reflect.get(point, "y");
      return typeof x === "number" && typeof y === "number" ? [{ x, y }] : [];
    });
  } catch {
    return [];
  }
}

function paintNode(element: SvgElement, shown: ShownNode, colors: DiagramColors): void {
  if (shown.faded) element.setAttribute("opacity", FADED_OPACITY);
  if (shown.change === "same") return;
  const color = colors[shown.change];
  for (const shape of element.querySelectorAll(SHAPES)) {
    if (isLabelPart(shape, element)) continue;
    addStyle(shape, `stroke:${color};fill:${mix(color, colors.background, FILL_STRENGTH)}`);
  }
  const member = (row: Row) => ({ rows: [row], same: colors.foreground });
  const texts = [...element.querySelectorAll("text")];
  const lines = [
    // Mermaid draws only a class's first annotation.
    ...shown.annotations.slice(0, 1).map(member),
    { rows: shown.label, same: color },
    ...[...shown.attributes, ...shown.methods].map(member),
  ];
  texts.forEach((text, i) => {
    const line = texts.length === lines.length ? lines[i] : { rows: [], same: color };
    paintText(text, line.rows, line.same, colors);
  });
}

/**
 * Colors a text by the rows it draws, a line or more each, crossing out removed ones; unchanged
 * rows take `same`.
 */
function paintText(text: SvgElement, rows: readonly Row[], same: string, colors: DiagramColors): void {
  const styleOf = ({ change }: Pick<Row, "change">) =>
    change === "same" ? `fill:${same}` : `fill:${colors[change]}${change === "removed" ? ";text-decoration:line-through" : ""}`;
  if (rows.length <= 1) {
    addStyle(text, styleOf(rows[0] ?? { change: "same" }));
    return;
  }
  const ends: number[] = [];
  for (const { text: row } of rows) ends.push((ends.at(-1) ?? 0) + visibleLength(row));
  let drawn = 0;
  for (const word of text.querySelectorAll("tspan")) {
    if (word.querySelector("tspan") != null) continue;
    const index = ends.findIndex((end) => drawn < end);
    addStyle(word, styleOf(rows[index < 0 ? rows.length - 1 : index]));
    drawn += visibleLength(word.textContent ?? "");
  }
}

/** Characters drawn for a row: mermaid wraps words but keeps every one, an entity code as one character. */
function visibleLength(source: string): number {
  return source.replace(/<br\s*\/?>/gi, "").replace(/[#&]\w+;/g, "_").replace(/\s/g, "").length;
}

/** Label backgrounds and boxes sized to the text, which keep the theme's colors. */
function isLabelPart(shape: SvgElement, node: SvgElement): boolean {
  if ((shape.getAttribute("class") ?? "").split(/\s+/).includes("background")) return true;
  for (let parent = shape.parentNode; parent != null && parent !== node; parent = parent.parentNode) {
    if ((parent.getAttribute("class") ?? "").split(/\s+/).includes("label")) return true;
  }
  return false;
}

function tintedMarker(svg: SvgElement, markers: Map<string, string>, id: string, color: string): string {
  const key = `${id}\u0000${color}`;
  const existing = markers.get(key);
  if (existing != null) return existing;
  const original = svg.querySelector(`[id="${id}"]`);
  if (original == null) return id;
  const tinted = `${id}-${color.slice(1)}`;
  const copy = original.cloneNode(true);
  copy.setAttribute("id", tinted);
  const hollow = HOLLOW_MARKER.test(original.getAttribute("class") ?? "");
  for (const shape of copy.querySelectorAll(SHAPES)) addStyle(shape, hollow ? `stroke:${color}` : `stroke:${color};fill:${color}`);
  original.parentNode?.appendChild(copy);
  markers.set(key, tinted);
  return tinted;
}

function addStyle(element: SvgElement, style: string): void {
  const existing = element.getAttribute("style");
  element.setAttribute("style", existing == null || existing === "" ? style : `${existing};${style}`);
}

function mix(color: string, base: string, amount: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  const parts = [1, 3, 5].map((at) => Math.round(channel(color, at) * amount + channel(base, at) * (1 - amount)));
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
