import type { Diagram, DiagramEdge, DiagramGroup, DiagramNode } from "./diagram";

type Fields = Readonly<Record<string, unknown>>;

const STROKES: Readonly<Record<string, readonly [body: string, openEnd: string]>> = {
  normal: ["--", "-"],
  thick: ["==", "="],
  dotted: ["-.-", ""],
};
const HEADS: Readonly<Record<string, readonly [end: string, start: string]>> = {
  point: [">", "<"],
  cross: ["x", "x"],
  circle: ["o", "o"],
};
const RELATION_STARTS = ["o", "<|", "*", "<", "()"];
const RELATION_ENDS = ["o", "|>", "*", ">", "()"];
const RELATION_LINES = ["--", ".."];

/** Null for a kind of diagram the visual diff does not draw. */
export function readDiagram(type: string, db: unknown): Diagram | null {
  const fields = asFields(db);
  if (type === "flowchart" || type === "flowchart-v2") return readFlowchart(fields);
  if (isClassDiagram(type)) return readClassDiagram(fields);
  return null;
}

/** In order, minus the SVG's own id they start with once drawn; lollipops, being part of a class, have none. */
export function edgeDomIds(type: string, db: unknown): string[] {
  const fields = asFields(db);
  if (isClassDiagram(type)) {
    const interfaces = lollipops(fields);
    return list(call(fields, "getRelations"))
      .map(asFields)
      .flatMap((relation, i) => (isLollipop(relation, interfaces) ? [] : [`id_${text(relation.id1)}_${text(relation.id2)}_${i + 1}`]));
  }
  return list(call(fields, "getEdges")).map((edge) => text(asFields(edge).id));
}

/** Mermaid's ids for lollipop interfaces, which it numbers as they're declared, to their label and class. */
function lollipops(db: Fields): ReadonlyMap<string, { label: string; classId: string }> {
  return new Map(
    list(db.interfaces)
      .map(asFields)
      .map((lollipop) => [text(lollipop.id), { label: text(lollipop.label), classId: text(lollipop.classId) }]),
  );
}

function isLollipop(relation: Fields, interfaces: ReadonlyMap<string, unknown>): boolean {
  return interfaces.has(text(relation.id1)) || interfaces.has(text(relation.id2));
}

function isClassDiagram(type: string): boolean {
  return type === "class" || type === "classDiagram";
}

function readFlowchart(db: Fields): Diagram {
  const subgraphs = list(call(db, "getSubGraphs")).map(asFields);
  const groupIds = stableGroupIds(subgraphs);
  const groupOf = new Map<string, string>();
  for (const subgraph of subgraphs) {
    for (const member of list(subgraph.nodes)) groupOf.set(text(member), groupIds.get(text(subgraph.id)) ?? "");
  }
  const nodes = entries(call(db, "getVertices")).map((vertex): DiagramNode => {
    const id = text(vertex.id);
    return {
      id,
      label: text(vertex.text) || id,
      shape: text(vertex.type) || "square",
      group: groupOf.get(id) ?? null,
      annotations: [],
      attributes: [],
      methods: [],
      interfaces: [],
    };
  });
  const edges = list(call(db, "getEdges")).map(
    (value): DiagramEdge => {
      const edge = asFields(value);
      return { from: text(edge.start), to: text(edge.end), link: flowLink(text(edge.type), text(edge.stroke)), label: text(edge.text) };
    },
  );
  const groups = subgraphs.map(
    (subgraph): DiagramGroup => ({
      id: groupIds.get(text(subgraph.id)) ?? "",
      title: text(subgraph.title),
      parent: groupOf.get(text(subgraph.id)) ?? null,
    }),
  );
  return {
    kind: "flowchart",
    direction: text(call(db, "getDirection")) || "TB",
    nodes: nodes.filter(({ id }) => !groupIds.has(id)),
    edges,
    groups,
  };
}

/**
 * Mermaid numbers subgraphs declared without an id by position, so a group added before others would
 * seem to change them all: those take an id from their title instead.
 */
function stableGroupIds(subgraphs: readonly Fields[]): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  const taken = new Set(subgraphs.map((subgraph) => text(subgraph.id)));
  for (const subgraph of subgraphs) {
    const id = text(subgraph.id);
    if (!/^subGraph\d+$/.test(id)) {
      ids.set(id, id);
      continue;
    }
    const base = `group_${text(subgraph.title).replace(/\W+/g, "_")}`;
    let stable = base;
    for (let n = 2; taken.has(stable); n++) stable = `${base}_${n}`;
    taken.add(stable);
    ids.set(id, stable);
  }
  return ids;
}

function flowLink(type: string, stroke: string): string {
  if (stroke === "invisible") return "~~~";
  const [body, openEnd] = STROKES[stroke] ?? STROKES.normal;
  const [, double, head] = /^(double_)?arrow_(\w+)$/.exec(type) ?? [];
  const ends = HEADS[head ?? ""];
  if (ends == null) return body + openEnd;
  return `${double == null ? "" : ends[1]}${body}${ends[0]}`;
}

function readClassDiagram(db: Fields): Diagram {
  const interfaces = lollipops(db);
  const nodes = entries(call(db, "getClasses")).map((cls): DiagramNode => {
    const id = text(cls.id);
    const generic = text(cls.type);
    return {
      id,
      label: generic === "" ? text(cls.label) || id : `${id}#lt;${generic}#gt;`,
      shape: "",
      group: null,
      annotations: list(cls.annotations).map(text),
      attributes: list(cls.members).map(asFields).map((member) => `${text(member.visibility)}${text(member.id)}${text(member.classifier)}`),
      methods: list(cls.methods).map(asFields).map((method) => {
        const returns = text(method.returnType);
        return `${text(method.visibility)}${text(method.id)}(${text(method.parameters)})${returns === "" ? "" : ` ${returns}`}${text(method.classifier)}`;
      }),
      interfaces: [...interfaces.values()].filter(({ classId }) => classId === id).map(({ label }) => label),
    };
  });
  const relations = list(call(db, "getRelations")).map(asFields);
  const edges = relations.filter((relation) => !isLollipop(relation, interfaces)).map((relation): DiagramEdge => {
    const kind = asFields(relation.relation);
    const cardinality = (title: unknown) => (text(title) === "" || title === "none" ? [] : [`"${text(title)}"`]);
    const arrow = `${RELATION_STARTS[Number(kind.type1)] ?? ""}${RELATION_LINES[Number(kind.lineType)] ?? "--"}${RELATION_ENDS[Number(kind.type2)] ?? ""}`;
    return {
      from: text(relation.id1),
      to: text(relation.id2),
      link: [...cardinality(relation.relationTitle1), arrow, ...cardinality(relation.relationTitle2)].join(" "),
      label: text(relation.title),
    };
  });
  return { kind: "class", direction: text(call(db, "getDirection")) || "TB", nodes, edges, groups: [] };
}

function call(db: Fields, method: string): unknown {
  const get = db[method];
  return typeof get === "function" ? get.call(db) : undefined;
}

function entries(value: unknown): Fields[] {
  return (value instanceof Map ? [...value.values()] : list(value)).map(asFields);
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asFields(value: unknown): Fields {
  return typeof value === "object" && value != null ? (value as Fields) : {};
}

/** As the source wrote it: mermaid's parser stores entity codes such as `#lt;` as `ﬂ°lt¶ß`. */
function text(value: unknown): string {
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value.replace(/ﬂ°°?/g, "#").replace(/¶ß/g, ";") : "";
}
