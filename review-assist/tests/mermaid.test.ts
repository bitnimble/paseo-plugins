import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { MermaidPalette } from "../shared/protocol";
import { type Diagram, type DiagramNode, diffDiagrams, diffRows, diffSource } from "../server/mermaid/diagram";
import { MermaidRenderer } from "../server/mermaid/renderer";

const node = (id: string, fields: Partial<DiagramNode> = {}): DiagramNode => ({
  id,
  label: id,
  shape: "square",
  group: null,
  annotations: [],
  attributes: [],
  methods: [],
  interfaces: [],
  ...fields,
});

const flowchart = (nodes: DiagramNode[], edges: [string, string, string?][]): Diagram => ({
  kind: "flowchart",
  direction: "LR",
  nodes,
  edges: edges.map(([from, to, label = ""]) => ({ from, to, link: "-->", label })),
  groups: [],
});

const chain = ["A", "B", "C", "D", "E"].map((id) => node(id));
const chainEdges: [string, string][] = [["A", "B"], ["B", "C"], ["C", "D"], ["D", "E"]];

describe("diffDiagrams", () => {
  test("is null when nothing changed", () => {
    assert.equal(diffDiagrams(flowchart(chain, chainEdges), flowchart(chain, chainEdges), 2), null);
  });

  test("keeps only the direct neighbours of a change at distance one", () => {
    const changed = chain.map((entry) => (entry.id === "C" ? node("C", { shape: "round" }) : entry));
    const diff = diffDiagrams(flowchart(chain, chainEdges), flowchart(changed, chainEdges), 1);
    assert.deepEqual(
      diff?.nodes.map(({ node: { id }, faded }) => [id, faded]),
      [
        ["B", false],
        ["C", false],
        ["D", false],
      ],
    );
    assert.deepEqual(
      diff?.cuts.map(({ node, incoming }) => [node, incoming]),
      [
        ["B", true],
        ["D", false],
      ],
    );
    assert.equal(diff?.truncated, true);
  });

  test("shows a node's move between groups, and a removed group with nothing left in it", () => {
    const grouped = (group: string | null): Diagram => ({
      ...flowchart([node("A", { group })], []),
      groups: [
        { id: "S", title: "Core", parent: null },
        { id: "T", title: "Edge", parent: null },
      ].filter(({ id }) => group != null || id !== "T"),
    });
    const moved = diffDiagrams(grouped("S"), grouped("T"), 1);
    assert.deepEqual(moved?.nodes[0].label, [
      { text: "A", change: "same" },
      { text: "in Core", change: "removed" },
      { text: "in Edge", change: "added" },
    ]);
    const unwrapped = diffDiagrams(grouped("T"), grouped(null), 1);
    assert.deepEqual(
      unwrapped?.groups.map(({ group, change }) => [group.id, change]),
      [["T", "removed"]],
    );
  });

  test("draws shapes without bracket syntax by name", () => {
    const diff = diffDiagrams(flowchart([node("A", { shape: "fork" })], []), flowchart([node("A", { shape: "hourglass" })], []), 1);
    assert.equal(
      diff == null ? null : diffSource(diff),
      'flowchart LR\n  A@{ shape: hourglass, label: "A<br>fork<br>hourglass" }\n',
    );
  });

  test("cuts no invisible links", () => {
    const nodes = [node("A"), node("B"), node("C")];
    const linked = (label: string): Diagram => ({
      ...flowchart(nodes, []),
      edges: [
        { from: "A", to: "B", link: "~~~", label: "" },
        { from: "B", to: "C", link: "-->", label },
      ],
    });
    const diff = diffDiagrams(linked(""), linked("next"), 1);
    assert.deepEqual(
      diff?.nodes.map(({ node: { id } }) => id),
      ["B", "C"],
    );
    assert.deepEqual(diff?.cuts, []);
  });

  test("keeps nodes within two links of a change, fading the furthest", () => {
    const changed = chain.map((entry) => (entry.id === "A" ? node("A", { shape: "round" }) : entry));
    const diff = diffDiagrams(flowchart(chain, chainEdges), flowchart(changed, chainEdges), 2);
    assert.deepEqual(
      diff?.nodes.map(({ node: { id }, change, faded }) => [id, change, faded]),
      [
        ["A", "changed", false],
        ["B", "same", false],
        ["C", "same", true],
      ],
    );
    assert.deepEqual(
      diff?.edges.map(({ edge, faded }) => [edge.from, edge.to, faded]),
      [
        ["A", "B", false],
        ["B", "C", true],
      ],
    );
  });

  test("cuts the links into what it leaves out, once per node and direction", () => {
    const changed = chain.map((entry) => (entry.id === "C" ? node("C", { shape: "round" }) : entry));
    const wide = (nodes: DiagramNode[]) =>
      flowchart([...nodes, node("F"), node("G")], [...chainEdges, ["F", "A"], ["G", "A"]]);
    const diff = diffDiagrams(wide(chain), wide(changed), 2);
    assert.deepEqual(
      diff?.nodes.map(({ node: { id } }) => id),
      ["A", "B", "C", "D", "E"],
    );
    assert.deepEqual(diff?.cuts, [{ node: "A", incoming: true, link: "-->", placeholder: "review_cut_0" }]);
    assert.match(diff == null ? "" : diffSource(diff), /\n {2}review_cut_0@\{ shape: f-circ \}\n[^]*\n {2}review_cut_0 --> A\n$/);
  });

  test("treats the ends of a changed edge as one link from the change", () => {
    const diff = diffDiagrams(
      flowchart(chain, chainEdges),
      flowchart(chain, [["A", "B"], ["B", "C", "next"], ["C", "D"], ["D", "E"]]),
      2,
    );
    assert.deepEqual(
      diff?.nodes.map(({ node: { id }, faded }) => [id, faded]),
      [
        ["A", true],
        ["B", false],
        ["C", false],
        ["D", true],
      ],
    );
    assert.deepEqual(
      diff?.edges.map(({ edge, change, faded }) => [edge.from, edge.to, change, faded]),
      [
        ["A", "B", "same", true],
        ["B", "C", "changed", false],
        ["C", "D", "same", true],
      ],
    );
  });

  test("keeps edges to a subgraph near a change", () => {
    const grouped = (label: string): Diagram => ({
      ...flowchart([node("A", { group: "S" }), node("C", { label })], [["S", "C"]]),
      groups: [{ id: "S", title: "Group", parent: null }],
    });
    const diff = diffDiagrams(grouped("C"), grouped("Changed"), 2);
    assert.deepEqual(
      diff?.edges.map(({ edge }) => [edge.from, edge.to]),
      [["S", "C"]],
    );
    assert.deepEqual(
      diff?.groups.map(({ group }) => group.id),
      ["S"],
    );
  });

  test("marks added and removed nodes and edges", () => {
    const diff = diffDiagrams(
      flowchart([node("A"), node("B")], [["A", "B"]]),
      flowchart([node("A"), node("C")], [["A", "C"]]),
      2,
    );
    assert.deepEqual(
      diff?.nodes.map(({ node: { id }, change }) => [id, change]),
      [
        ["A", "same"],
        ["C", "added"],
        ["B", "removed"],
      ],
    );
    assert.deepEqual(
      diff?.edges.map(({ edge, change }) => [edge.to, change]),
      [
        ["C", "added"],
        ["B", "removed"],
      ],
    );
    assert.equal(diff?.truncated, false);
  });

  test("colors a class's rows on their own", () => {
    const before = node("Animal", { attributes: ["+String name", "-int age"], methods: ["+eat()"] });
    const changed = node("Animal", { attributes: ["+String name", "+int legs"], methods: ["+eat()"] });
    const diff = diffDiagrams(
      { ...flowchart([before], []), kind: "class" },
      { ...flowchart([changed], []), kind: "class" },
      2,
    );
    assert.equal(diff?.nodes[0].change, "changed");
    assert.deepEqual(diff?.nodes[0].attributes, [
      { text: "+String name", change: "same" },
      { text: "+int legs", change: "added" },
      { text: "-int age", change: "removed" },
    ]);
    assert.equal(
      diff == null ? null : diffSource(diff),
      "classDiagram\n  direction LR\n  class Animal {\n    +String name\n    +int legs\n    -int age\n    +eat()\n  }\n",
    );
  });

  test("draws a changed label, shape or link as its old value then its new one", () => {
    const diff = diffDiagrams(
      { ...flowchart([node("A"), node("B", { label: "Cold archive", shape: "cylinder" })], []), edges: [{ from: "A", to: "B", link: "-->", label: "" }] },
      {
        ...flowchart([node("A"), node("B", { label: "Glacier archive", shape: "lean_right" })], []),
        edges: [{ from: "A", to: "B", link: "-.->", label: "ships" }],
      },
      1,
    );
    assert.deepEqual(diff?.nodes[1].label, [
      { text: "Cold archive", change: "removed" },
      { text: "Glacier archive", change: "added" },
      { text: "cylinder", change: "removed" },
      { text: "lean right", change: "added" },
    ]);
    assert.deepEqual(diff?.edges[0].label, [
      { text: "ships", change: "added" },
      { text: "--#gt;", change: "removed" },
      { text: "-.-#gt;", change: "added" },
    ]);
    assert.equal(
      diff == null ? null : diffSource(diff),
      'flowchart LR\n  A["A"]\n  B[/"Cold archive<br>Glacier archive<br>cylinder<br>lean right"/]\n  A -.->|"ships<br>--#gt;<br>-.-#gt;"| B\n',
    );
  });
});

describe("diffRows", () => {
  test("merges both sides in order", () => {
    assert.deepEqual(diffRows(["a", "b", "c"], ["a", "x", "c", "d"]), [
      { text: "a", change: "same" },
      { text: "x", change: "added" },
      { text: "b", change: "removed" },
      { text: "c", change: "same" },
      { text: "d", change: "added" },
    ]);
  });
});

describe("MermaidRenderer", () => {
  const renderer = new MermaidRenderer();
  after(() => renderer.dispose());
  const palette: MermaidPalette = {
    dark: true,
    background: "#181818",
    surface: "#242424",
    foreground: "#e6e6e6",
    muted: "#9a9a9a",
    border: "#3a3a3a",
    added: "#00ff00",
    removed: "#ff0000",
    changed: "#ffaa00",
  };
  const draw = (older: string, newer: string, format: "svg" | "png" = "svg") =>
    renderer.draw({ before: older, after: newer, format, palette, distance: 2 });
  const svgOf = (uri: string) => decodeURIComponent(uri.slice(uri.indexOf(",") + 1));
  const nodeStyles = (svg: string, id: string) => {
    const start = svg.search(new RegExp(`<g[^>]*id="[^"]*-(?:flowchart|classId)-${id}-\\d+"`));
    if (start < 0) return null;
    const end = svg.indexOf('class="node', svg.indexOf(">", start));
    return svg.slice(start, end < 0 ? undefined : end);
  };

  test("paints changes and leaves out what is far from them", async () => {
    const outcome = await draw(
      "flowchart LR\n  A[Start] --> B[Save]\n  B --> C[Notify]\n  C --> D[Archive]\n  D --> E[Purge]",
      "flowchart LR\n  A[Start] --> B[Save to DB]\n  B --> C[Notify]\n  C --> D[Archive]\n  D --> E[Purge]\n  B --> N[Audit]",
    );
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    const svg = svgOf(outcome.uri);
    assert.match(nodeStyles(svg, "B") ?? "", /stroke:#ffaa00/);
    assert.match(nodeStyles(svg, "N") ?? "", /stroke:#00ff00/);
    assert.notEqual(nodeStyles(svg, "C"), null);
    assert.doesNotMatch(nodeStyles(svg, "C") ?? "", /stroke:#/);
    assert.match(svg, /id="[^"]*-flowchart-D-\d+"[^>]*opacity="0.35"|opacity="0.35"[^>]*id="[^"]*-flowchart-D-\d+"/);
    assert.equal(nodeStyles(svg, "E"), null);
    assert.match(svg, /id="[^"]*-L_B_N_0"[^>]*style="[^"]*stroke:#00ff00/);
    const stub = /<path[^>]*class="[^"]*review-cut[^"]*"[^>]*>/.exec(svg)?.[0] ?? "";
    assert.match(stub, /d="M[\d.,-]+L[\d.,-]+"/);
    assert.doesNotMatch(stub, /marker-end/);
    assert.equal(svg.match(/<line[^>]*edge-pattern-solid/g)?.length, 2);
    assert.doesNotMatch(svg, /-flowchart-review_cut_0-/);
    assert.equal(outcome.truncated, true);
  });

  test("matches subgraphs without ids by title, not position", async () => {
    const alpha = 'subgraph "Alpha group"\n    A[Kept]\n  end';
    const outcome = await draw(`flowchart LR\n  ${alpha}`, `flowchart LR\n  subgraph "New group"\n    N[Added]\n  end\n  ${alpha}`);
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    const svg = svgOf(outcome.uri);
    assert.match(nodeStyles(svg, "N") ?? "", /stroke:#00ff00/);
    assert.equal(nodeStyles(svg, "A"), null);
  });

  test("draws a new diagram as all added", async () => {
    const outcome = await draw("", "flowchart LR\n  A --> B");
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    const svg = svgOf(outcome.uri);
    assert.match(nodeStyles(svg, "A") ?? "", /stroke:#00ff00/);
    assert.match(nodeStyles(svg, "B") ?? "", /stroke:#00ff00/);
    assert.equal(outcome.truncated, false);
  });

  test("centres labels of several words as a browser would", async () => {
    const outcome = await draw("flowchart LR\n  A[(Cold archive)]", "flowchart LR\n  A[(Glacier archive)]");
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    const label = /class="label"[^>]*transform="translate\(([-\d.]+),/.exec(nodeStyles(svgOf(outcome.uri), "A") ?? "");
    assert.equal(Math.round(Number(label?.[1])), 0);
  });

  test("crosses out what a change removed, in red, beside what it added, in green", async () => {
    const outcome = await draw(
      'flowchart LR\n  A["Cold #lt;v1#gt;<br>archive"]\n  B[Store]',
      'flowchart LR\n  A["Glacier<br>archive"]\n  B[Store]',
    );
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    const words = [...(nodeStyles(svgOf(outcome.uri), "A") ?? "").matchAll(/<tspan[^>]*style="([^"]*)"[^>]*>([^<]+)<\/tspan>/g)];
    assert.deepEqual(
      words.map(([, style, word]) => [word.trim(), style]),
      [
        ["Cold", "fill:#ff0000;text-decoration:line-through"],
        ["&lt;v1&gt;", "fill:#ff0000;text-decoration:line-through"],
        ["archive", "fill:#ff0000;text-decoration:line-through"],
        ["Glacier", "fill:#00ff00"],
        ["archive", "fill:#00ff00"],
      ],
    );

    const members = await draw("classDiagram\n  class A {\n    +int x\n  }", "classDiagram\n  class A {\n    +int y\n  }");
    if (members.status !== "ready") return assert.fail(members.status);
    const texts = [...(nodeStyles(svgOf(members.uri), "A") ?? "").matchAll(/<text[^>]*style="([^"]*)"[^>]*>([^]*?)<\/text>/g)];
    assert.deepEqual(
      texts.map(([, style, row]) => [row.replace(/<[^>]*>/g, "").trim(), style]),
      [
        ["A", "fill:#ffaa00"],
        ["+int y", "fill:#00ff00"],
        ["+int x", "fill:#ff0000;text-decoration:line-through"],
      ],
    );
  });

  test("seats class markers' tips on the box they point at", async () => {
    const outcome = await draw("classDiagram\n  A <|-- B", "classDiagram\n  A <|-- B\n  class A {\n    +int x\n  }");
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    const svg = svgOf(outcome.uri);
    const box = /id="[^"]*-classId-A-\d+"[^>]*translate\([-\d.]+, ?([-\d.]+)\)"[^>]*>(?:<g[^>]*>)?<path d="M[-\d.]+ (-[\d.]+)/.exec(svg);
    const start = /<path d="M[-\d.]+,([-\d.]+)[^"]*" id="[^"]*-id_A_B_1"/.exec(svg);
    const hollowTriangleReach = 8;
    assert.equal(
      Math.round(Number(start?.[1]) - (Number(box?.[1]) - Number(box?.[2]))),
      hollowTriangleReach,
    );
  });

  test("colors lollipop interfaces as rows of their class", async () => {
    const outcome = await draw(
      "classDiagram\n  A <|-- B\n  Old ()-- B",
      "classDiagram\n  A <|-- B\n  Old ()-- B\n  New ()-- B",
    );
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    const svg = svgOf(outcome.uri);
    assert.match(nodeStyles(svg, "B") ?? "", /stroke:#ffaa00/);
    const labelOf = (n: number) => new RegExp(`id="[^"]*-interface${n}"(?:(?!</g>)[^])*?<text([^>]*)>`).exec(svg)?.[1];
    assert.match(labelOf(1) ?? "", /fill:#00ff00/);
    assert.equal(labelOf(0)?.includes("fill:#"), false);
  });

  test("rasterizes for clients that can't show SVG", async () => {
    const outcome = await draw("flowchart LR\n  A --> B", "flowchart LR\n  A --> C", "png");
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    assert.ok(outcome.uri.startsWith("data:image/png;base64,iVBORw0KGgo"));
  });

  test("explains diagrams it doesn't draw", async () => {
    assert.deepEqual(await draw("flowchart LR\n  A --> B", "flowchart LR\n  A --> B\n"), {
      status: "unavailable",
      reason: "No node, link or group changed.",
    });
    assert.deepEqual(await draw("sequenceDiagram\n  A->>B: hi", "sequenceDiagram\n  A->>B: yo"), {
      status: "unavailable",
      reason: "Visual diffs draw flowcharts and class diagrams.",
    });
    const broken = await draw("flowchart LR\n  A -->", "flowchart LR\n  A --> B");
    assert.equal(broken.status === "unavailable" && broken.reason.split(":")[0], "The diagram before this change doesn't parse");
  });

  test("lays cylinders out at their drawn height", async () => {
    const outcome = await draw("flowchart LR\n  A[(Store)]", "flowchart LR\n  A[(Shop)]");
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    assert.ok(outcome.height < 160, `drawn ${outcome.height} tall`);
  });
});

describe("MermaidRenderer's worker", () => {
  const ready = { status: "ready", uri: "data:,", width: 1, height: 1, truncated: false };
  const fakeWorker = `
    const { parentPort } = require("node:worker_threads");
    let hung = false;
    parentPort.on("message", (request) => {
      if (request.before === "crash") throw new Error("boom");
      hung ||= request.before === "hang";
      if (hung) return;
      parentPort.postMessage({ id: request.id, outcome: ${JSON.stringify(ready)} });
    });
  `;
  const palette: MermaidPalette = {
    dark: true,
    background: "#000000",
    surface: "#000000",
    foreground: "#ffffff",
    muted: "#ffffff",
    border: "#ffffff",
    added: "#00ff00",
    removed: "#ff0000",
    changed: "#ffaa00",
  };
  const request = (before: string) => ({ before, after: "", format: "svg" as const, palette, distance: 1 });

  test("reports a crash, then starts a new worker for the next diagram", async () => {
    const renderer = new MermaidRenderer(fakeWorker);
    try {
      assert.deepEqual(await renderer.draw(request("crash")), {
        status: "unavailable",
        reason: "The diagram renderer crashed: boom",
      });
      assert.deepEqual(await renderer.draw(request("fine")), ready);
    } finally {
      renderer.dispose();
    }
  });

  test("gives up on a worker that stops answering, failing every diagram waiting on it", async () => {
    const renderer = new MermaidRenderer(fakeWorker, 100);
    try {
      const stuck = "The diagram took too long to draw.";
      const outcomes = await Promise.all([renderer.draw(request("hang")), renderer.draw(request("fine"))]);
      assert.deepEqual(outcomes, [
        { status: "unavailable", reason: stuck },
        { status: "unavailable", reason: stuck },
      ]);
      assert.deepEqual(await renderer.draw(request("fine")), ready);
    } finally {
      renderer.dispose();
    }
  });
});
