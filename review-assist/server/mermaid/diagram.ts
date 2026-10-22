export type DiagramKind = "flowchart" | "class";

export const SHAPES: Readonly<Record<string, readonly [open: string, close: string]>> = {
  square: ["[", "]"],
  round: ["(", ")"],
  stadium: ["([", "])"],
  subroutine: ["[[", "]]"],
  cylinder: ["[(", ")]"],
  circle: ["((", "))"],
  doublecircle: ["(((", ")))"],
  ellipse: ["(-", "-)"],
  diamond: ["{", "}"],
  hexagon: ["{{", "}}"],
  odd: [">", "]"],
  lean_right: ["[/", "/]"],
  lean_left: ["[\\", "\\]"],
  trapezoid: ["[/", "\\]"],
  inv_trapezoid: ["[\\", "/]"],
};

export interface DiagramNode {
  readonly id: string;
  /** As mermaid's source writes it, entity codes and `<br>` included. */
  readonly label: string;
  /** Mermaid's name for a flowchart node's shape, empty for a class. */
  readonly shape: string;
  readonly group: string | null;
  readonly annotations: readonly string[];
  readonly attributes: readonly string[];
  readonly methods: readonly string[];
  /** Labels of the lollipop interfaces drawn on a class. */
  readonly interfaces: readonly string[];
}

export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  /** Mermaid syntax between the two ends, e.g. `-.->` or `"1" <|-- "*"`. */
  readonly link: string;
  readonly label: string;
}

export interface DiagramGroup {
  readonly id: string;
  readonly title: string;
  readonly parent: string | null;
}

export interface Diagram {
  readonly kind: DiagramKind;
  readonly direction: string;
  readonly nodes: readonly DiagramNode[];
  readonly edges: readonly DiagramEdge[];
  readonly groups: readonly DiagramGroup[];
}

export type Change = "added" | "removed" | "changed" | "same";

export interface Row {
  readonly text: string;
  readonly change: Change;
}

export interface ShownNode {
  readonly node: DiagramNode;
  readonly change: Change;
  readonly faded: boolean;
  /** A line each: the label's rows, a changed one as its old row then its new, then the shape's. */
  readonly label: readonly Row[];
  readonly annotations: readonly Row[];
  readonly attributes: readonly Row[];
  readonly methods: readonly Row[];
  readonly interfaces: readonly Row[];
}

export interface ShownEdge {
  readonly edge: DiagramEdge;
  readonly change: Change;
  readonly faded: boolean;
  /** The label's rows, then the link's where it changed. */
  readonly label: readonly Row[];
}

export interface ShownGroup {
  readonly group: DiagramGroup;
  readonly change: Change;
  readonly title: readonly Row[];
}

/**
 * A shown node's links to nodes left out, drawn as one stub per direction: a link to a placeholder
 * node in the same group, which holds room for it in the layout and is hidden once drawn.
 */
export interface Cut {
  readonly node: string;
  readonly incoming: boolean;
  /** The first cut link's syntax, which the stub is drawn with. */
  readonly link: string;
  readonly placeholder: string;
}

/** Both diagrams laid over each other, keeping what is within some number of links of a change. */
export interface DiagramDiff {
  readonly kind: DiagramKind;
  readonly direction: string;
  readonly nodes: readonly ShownNode[];
  readonly edges: readonly ShownEdge[];
  readonly groups: readonly ShownGroup[];
  readonly cuts: readonly Cut[];
  readonly truncated: boolean;
}

const CUT_PREFIX = "review_cut_";
const INVISIBLE_LINK = "~~~";

/**
 * Null when the two diagrams are the same. Keeps nodes up to `distance` links from a change, fading
 * those past its direct neighbours.
 */
export function diffDiagrams(before: Diagram, after: Diagram, distance: number): DiagramDiff | null {
  const nodes = diffNodes(before, after);
  const edges = diffEdges(before.edges, after.edges);
  const groups = diffGroups(before.groups, after.groups);
  if ([...nodes, ...edges, ...groups].every(({ change }) => change === "same")) return null;

  const distances = distancesFromChanges(nodes, edges, groups, distance);
  const shown = (id: string) => (distances.get(id) ?? Infinity) <= distance;
  const faded = (id: string) => (distances.get(id) ?? 0) >= 2;
  const shownNodes = nodes.filter(({ node }) => shown(node.id)).map((entry) => ({ ...entry, faded: faded(entry.node.id) }));
  const parents = new Map(groups.map(({ group }) => [group.id, group.parent]));
  const shownGroupIds = new Set<string>();
  const linkedGroups = groups.filter(({ group }) => shown(group.id)).map(({ group }) => group.id);
  for (const start of [...shownNodes.map(({ node }) => node.group), ...linkedGroups]) {
    for (let id = start; id != null && !shownGroupIds.has(id); id = parents.get(id) ?? null) shownGroupIds.add(id);
  }
  const shownIds = new Set([...shownNodes.map(({ node }) => node.id), ...shownGroupIds]);
  return {
    kind: after.kind,
    direction: after.direction,
    nodes: shownNodes,
    edges: edges
      .filter(({ edge }) => shownIds.has(edge.from) && shownIds.has(edge.to))
      .map((entry) => ({
        ...entry,
        faded: entry.change === "same" && (faded(entry.edge.from) || faded(entry.edge.to)),
      })),
    groups: groups.filter(({ group }) => shownGroupIds.has(group.id)),
    cuts: cutsAt(edges, shownIds),
    truncated: shownNodes.length < nodes.length,
  };
}

function cutsAt(edges: readonly ShownEdge[], shownIds: ReadonlySet<string>): Cut[] {
  const cuts = new Map<string, Cut>();
  for (const { edge } of edges) {
    if (shownIds.has(edge.from) === shownIds.has(edge.to) || edge.link === INVISIBLE_LINK) continue;
    const incoming = shownIds.has(edge.to);
    const node = incoming ? edge.to : edge.from;
    const key = `${node}\u0000${incoming}`;
    if (!cuts.has(key)) cuts.set(key, { node, incoming, link: edge.link, placeholder: `${CUT_PREFIX}${cuts.size}` });
  }
  return [...cuts.values()];
}

/** Mermaid source drawing the diff, nodes and edges in the diff's order. */
export function diffSource(diff: DiagramDiff): string {
  const lines = diff.kind === "flowchart" ? [`flowchart ${diff.direction}`] : ["classDiagram", `  direction ${diff.direction}`];
  const childGroups = (parent: string | null) => diff.groups.filter(({ group }) => group.parent === parent);
  const childNodes = (group: string | null) => diff.nodes.filter(({ node }) => node.group === group);
  const groupOf = new Map(diff.nodes.map(({ node }) => [node.id, node.group]));
  const isClass = diff.kind === "class";
  const emit = (group: string | null, indent: string) => {
    for (const { group: child, title: rows } of childGroups(group)) {
      const title = lineOf(rows);
      lines.push(`${indent}subgraph ${child.id}${title === child.id ? "" : ` ["${quoted(title)}"]`}`);
      emit(child.id, `${indent}  `);
      lines.push(`${indent}end`);
    }
    for (const shown of childNodes(group)) lines.push(...nodeLines(diff.kind, shown, indent));
    for (const { node, placeholder } of diff.cuts) {
      if ((groupOf.get(node) ?? null) === group) lines.push(isClass ? `${indent}class ${placeholder}[" "]` : `${indent}${placeholder}@{ shape: f-circ }`);
    }
  };
  emit(null, "  ");
  for (const { edge, label: rows } of diff.edges) {
    const label = lineOf(rows);
    if (isClass) lines.push(`  ${edge.from} ${edge.link} ${edge.to}${label === "" ? "" : ` : ${label}`}`);
    else lines.push(`  ${edge.from} ${edge.link}${label === "" ? "" : `|"${quoted(label)}"|`} ${edge.to}`);
  }
  for (const { node, incoming, link, placeholder } of diff.cuts) {
    lines.push(incoming ? `  ${placeholder} ${link} ${node}` : `  ${node} ${link} ${placeholder}`);
  }
  for (const { node, interfaces } of diff.nodes) lines.push(...interfaces.map(({ text }) => `  ${text} ()-- ${node.id}`));
  return `${lines.join("\n")}\n`;
}

function quoted(text: string): string {
  return text.replace(/"/g, "#quot;");
}

function lineOf(rows: readonly Row[]): string {
  return rows.map(({ text }) => text).join("<br>");
}

function nodeLines(kind: DiagramKind, { node, label, annotations, attributes, methods }: ShownNode, indent: string): string[] {
  const title = lineOf(label);
  if (kind === "flowchart") {
    const brackets = SHAPES[node.shape];
    if (brackets == null) return [`${indent}${node.id}@{ shape: ${node.shape}, label: "${quoted(title)}" }`];
    return [`${indent}${node.id}${brackets[0]}"${quoted(title)}"${brackets[1]}`];
  }
  const name = title === node.id ? node.id : `${node.id}["${quoted(title)}"]`;
  const rows = [...annotations.map(({ text }) => `<<${text}>>`), ...[...attributes, ...methods].map(({ text }) => text)];
  if (rows.length === 0) return [`${indent}class ${name}`];
  return [`${indent}class ${name} {`, ...rows.map((row) => `${indent}  ${row}`), `${indent}}`];
}

function diffNodes(before: Diagram, after: Diagram): ShownNode[] {
  const old = new Map(before.nodes.map((node) => [node.id, node]));
  const current = new Set(after.nodes.map(({ id }) => id));
  const placeOf = (diagram: Diagram, group: string | null) => {
    const title = diagram.groups.find(({ id }) => id === group)?.title;
    return title == null ? "" : `in ${title}`;
  };
  const entries = after.nodes.map((node): ShownNode => {
    const previous = old.get(node.id);
    if (previous == null) return whole(node, "added");
    const annotations = diffRows(previous.annotations, node.annotations);
    const attributes = diffRows(previous.attributes, node.attributes);
    const methods = diffRows(previous.methods, node.methods);
    const interfaces = diffRows(previous.interfaces, node.interfaces);
    const label = [
      ...revised(previous.label, node.label),
      ...revisedIfChanged(shapeName(previous.shape), shapeName(node.shape)),
      ...revisedIfChanged(placeOf(before, previous.group), placeOf(after, node.group)),
    ];
    const same =
      previous.group === node.group &&
      [...label, ...annotations, ...attributes, ...methods, ...interfaces].every(({ change }) => change === "same");
    return { node, change: same ? "same" : "changed", faded: false, label, annotations, attributes, methods, interfaces };
  });
  return [...entries, ...before.nodes.filter(({ id }) => !current.has(id)).map((node) => whole(node, "removed"))];
}

/** One row while the value is unchanged, else the old value's row then the new one's; never an empty row. */
function revised(before: string, after: string): Row[] {
  const rows: Row[] = before === after ? [{ text: after, change: "same" }] : [
    { text: before, change: "removed" },
    { text: after, change: "added" },
  ];
  return rows.filter(({ text }) => text !== "");
}

function revisedIfChanged(before: string, after: string): Row[] {
  return before === after ? [] : revised(before, after);
}

function shapeName(shape: string): string {
  return shape.replace(/_/g, " ");
}

function linkText(link: string): string {
  return link.replace(/</g, "#lt;").replace(/>/g, "#gt;");
}

function whole(node: DiagramNode, change: Change): ShownNode {
  const rows = (texts: readonly string[]) => texts.map((text) => ({ text, change }));
  return {
    node,
    change,
    faded: false,
    label: rows([node.label]),
    annotations: rows(node.annotations),
    attributes: rows(node.attributes),
    methods: rows(node.methods),
    interfaces: rows(node.interfaces),
  };
}

export function diffRows(before: readonly string[], after: readonly string[]): Row[] {
  const common: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      common[i][j] = before[i] === after[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      rows.push({ text: after[j], change: "same" });
      i++;
      j++;
    } else if (j < after.length && (i === before.length || common[i][j + 1] >= common[i + 1][j])) {
      rows.push({ text: after[j++], change: "added" });
    } else {
      rows.push({ text: before[i++], change: "removed" });
    }
  }
  return rows;
}

function diffEdges(before: readonly DiagramEdge[], after: readonly DiagramEdge[]): ShownEdge[] {
  const unmatched = new Map<string, DiagramEdge[]>();
  for (const edge of before) unmatched.set(endsKey(edge), [...(unmatched.get(endsKey(edge)) ?? []), edge]);
  const exact = after.map((edge) => {
    const candidates = unmatched.get(endsKey(edge)) ?? [];
    const index = candidates.findIndex((old) => old.link === edge.link && old.label === edge.label);
    if (index >= 0) candidates.splice(index, 1);
    return index >= 0;
  });
  const entries = after.map((edge, i): ShownEdge => {
    if (exact[i]) return wholeEdge(edge, "same");
    const old = unmatched.get(endsKey(edge))?.shift();
    if (old == null) return wholeEdge(edge, "added");
    const label = [...revised(old.label, edge.label), ...revisedIfChanged(linkText(old.link), linkText(edge.link))];
    return { edge, change: "changed", faded: false, label };
  });
  return [...entries, ...[...unmatched.values()].flat().map((edge) => wholeEdge(edge, "removed"))];
}

function wholeEdge(edge: DiagramEdge, change: Change): ShownEdge {
  return { edge, change, faded: false, label: edge.label === "" ? [] : [{ text: edge.label, change }] };
}

function endsKey(edge: DiagramEdge): string {
  return `${edge.from}\u0000${edge.to}`;
}

function diffGroups(before: readonly DiagramGroup[], after: readonly DiagramGroup[]): ShownGroup[] {
  const old = new Map(before.map((group) => [group.id, group]));
  const current = new Set(after.map(({ id }) => id));
  const whole = (group: DiagramGroup, change: Change): ShownGroup => ({ group, change, title: [{ text: group.title, change }] });
  const entries = after.map((group): ShownGroup => {
    const previous = old.get(group.id);
    if (previous == null) return whole(group, "added");
    const same = previous.title === group.title && previous.parent === group.parent;
    return { group, change: same ? "same" : "changed", title: revised(previous.title, group.title) };
  });
  return [...entries, ...before.filter(({ id }) => !current.has(id)).map((group) => whole(group, "removed"))];
}

/**
 * Links between a node or group and a change: 0 for a changed one, 1 for an end of a changed edge or a
 * node in a changed group.
 */
function distancesFromChanges(
  nodes: readonly ShownNode[],
  edges: readonly ShownEdge[],
  groups: readonly ShownGroup[],
  limit: number,
): Map<string, number> {
  const distances = new Map<string, number>();
  const neighbours = new Map<string, string[]>();
  for (const { edge } of edges) {
    neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to]);
    neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from]);
  }
  const changedGroups = new Set(groups.filter(({ change }) => change !== "same").map(({ group }) => group.id));
  const levels: string[][] = [
    [...nodes.filter(({ change }) => change !== "same").map(({ node }) => node.id), ...changedGroups],
    [
      ...edges.filter(({ change }) => change !== "same").flatMap(({ edge }) => [edge.from, edge.to]),
      ...nodes.filter(({ node }) => node.group != null && changedGroups.has(node.group)).map(({ node }) => node.id),
    ],
  ];
  for (let distance = 0; distance <= limit; distance++) {
    const level = (levels[distance] ?? []).filter((id) => !distances.has(id));
    for (const id of level) distances.set(id, distance);
    levels[distance + 1] = [...(levels[distance + 1] ?? []), ...level.flatMap((id) => neighbours.get(id) ?? [])];
  }
  return distances;
}
