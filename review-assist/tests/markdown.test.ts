import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownDiff } from "../server/markdown";
import type { MarkdownBlock, MarkdownEntry, MarkdownRun } from "../shared/protocol";

function entries(before: string, after: string): MarkdownEntry[] {
  const outcome = markdownDiff(before, after);
  assert.equal(outcome.status, "ready", outcome.status === "unavailable" ? outcome.reason : "");
  return outcome.status === "ready" ? outcome.entries : [];
}

/** Each entry as `change prefix text`, removed words as [-x-] and added ones as {+x+}. */
function summary(list: readonly MarkdownEntry[]): string[] {
  return list.map(({ change, quote, list: item, block }) => {
    const marker = item == null ? "" : `${"  ".repeat(item.depth - 1)}${item.marker ?? "·"}`;
    return [change, ">".repeat(quote), marker, content(block)].filter((part) => part !== "").join(" ");
  });
}

function content(block: MarkdownBlock): string {
  switch (block.kind) {
    case "heading":
      return `${"#".repeat(block.depth)} ${marked(block.runs)}`;
    case "text":
      return marked(block.runs);
    case "code":
      return `\`\`\` ${block.lines.map(({ text, change }) => mark(text, change)).join(" / ")}`;
    case "table":
      return block.rows.map((row) => mark(row.cells.map(marked).join(" | "), row.change)).join(" / ");
    case "rule":
      return "---";
  }
}

function marked(runs: readonly MarkdownRun[]): string {
  return runs.map((run) => mark(run.text, run.change)).join("");
}

function mark(text: string, change: "added" | "removed" | null): string {
  if (change === "removed") return `[-${text}-]`;
  if (change === "added") return `{+${text}+}`;
  return text;
}

test("an edited sentence marks the words that changed", () => {
  assert.deepEqual(summary(entries("# Shelf\n\nThe quick brown fox.\n", "# Shelf\n\nThe quick red fox.\n")), [
    "same # Shelf",
    "changed The quick [-brown-]{+red+} fox.",
  ]);
});

test("a rewritten paragraph reads as removed and added", () => {
  assert.deepEqual(summary(entries("Bookmarks load all at once.\n", "Pages of fifty arrive on demand.\n")), [
    "removed Bookmarks load all at once.",
    "added Pages of fifty arrive on demand.",
  ]);
});

test("a run of changed words stays one change across the spaces between them", () => {
  assert.deepEqual(summary(entries("Save it to the old shelf today.\n", "Save it to a new rack today.\n")), [
    "changed Save it to [-the old shelf-]{+a new rack+} today.",
  ]);
});

test("list items are blocks of their own, nested under their parents", () => {
  assert.deepEqual(summary(entries("- one\n- two\n", "- one\n  - one and a half\n- two\n3. three\n")), [
    "same • one",
    "added   • one and a half",
    "same • two",
    "added 3. three",
  ]);
});

test("ticking a task changes the item without changing its words", () => {
  assert.deepEqual(summary(entries("- [ ] ship it\n- [ ] tell people\n", "- [x] ship it\n- [ ] tell people\n")), [
    "changed ☑ ship it",
    "same ☐ tell people",
  ]);
});

test("code blocks compare line by line", () => {
  const before = "```ts\nconst a = 1;\nconst b = 2;\nexport { a, b };\n```\n";
  const after = "```ts\nconst a = 1;\nconst b = 3;\nexport { a, b };\n```\n";
  assert.deepEqual(summary(entries(before, after)), [
    "changed ``` const a = 1; / [-const b = 2;-] / {+const b = 3;+} / export { a, b };",
  ]);
});

test("table rows compare one by one", () => {
  const before = "| Method | Path |\n| --- | --- |\n| GET | /items |\n";
  const after = "| Method | Path |\n| --- | --- |\n| GET | /items |\n| POST | /items |\n";
  assert.deepEqual(summary(entries(before, after)), ["changed Method | Path / GET | /items / {+POST | /items+}"]);
});

test("an edited table cell marks the words that changed in it", () => {
  const table = (get: string) =>
    `| Method | Path | Description |\n| --- | --- | --- |\n${get}\n| DELETE | /items/:id | Remove one |\n`;
  const before = table("| GET | /items | Every item, newest first |");
  const after = table("| GET | /items?page= | One page of items, newest first |");
  assert.deepEqual(summary(entries(before, after)), [
    [
      "changed Method | Path | Description",
      "GET | /items{+?page=+} | [-Every item-]{+One page of items+}, newest first",
      "DELETE | /items/:id | Remove one",
    ].join(" / "),
  ]);
});

test("renamed and added columns line up with the rest of the table", () => {
  const before = "| Name | Size | Notes |\n| --- | --- | --- |\n| a.png | 2 KB | logo |\n";
  const after = "| Name | Type | Bytes |\n| --- | --- | --- |\n| a.png | image | 2048 |\n";
  const [table] = entries(before, after);
  assert.deepEqual(table.block.kind === "table" ? table.block.columns.map(({ change }) => change) : [], [
    null,
    null,
    null,
  ]);
  assert.deepEqual(summary([table]), [
    "changed Name | [-Size-]{+Type+} | [-Notes-]{+Bytes+} / a.png | [-2 KB-]{+image+} | [-logo-]{+2048+}",
  ]);
  const [widened] = entries(
    "| Name | Size |\n| --- | --- |\n| a.png | 2 KB |\n",
    "| Name | Type | Size |\n| --- | --- | --- |\n| a.png | image | 2 KB |\n",
  );
  assert.deepEqual(widened.block.kind === "table" ? widened.block.columns.map(({ change }) => change) : [], [
    null,
    "added",
    null,
  ]);
  assert.deepEqual(summary([widened]), ["changed Name | {+Type+} | Size / a.png | {+image+} | 2 KB"]);
});

test("each block knows the lines it is written on, removed ones in the old text", () => {
  const before = "# Notes\n\n> Kept in a quote,\n> over two lines.\n\n- first\n- second\n";
  const after = "# Notes\n\n> Kept in a quote,\n> over two lines.\n\n- first\n  - nested\n";
  assert.deepEqual(
    entries(before, after).map(({ change, lines }) => [change, lines]),
    [
      ["same", { side: "new", start: 0, end: 0 }],
      ["same", { side: "new", start: 2, end: 3 }],
      ["same", { side: "new", start: 5, end: 5 }],
      ["removed", { side: "old", start: 6, end: 6 }],
      ["added", { side: "new", start: 6, end: 6 }],
    ],
  );
});

test("a block is found on its own line, not on an earlier one that only contains its text", () => {
  const source = "<!-- # A -->\n# A\n\n[a]: https://x.test\na\n";
  assert.deepEqual(
    entries("", source).map(({ lines }) => lines),
    [
      { side: "new", start: 1, end: 1 },
      { side: "new", start: 4, end: 4 },
    ],
  );
});

test("a heading moved to another level reads as removed and added", () => {
  assert.deepEqual(summary(entries("## Paging\n", "### Paging\n")), ["removed ## Paging", "added ### Paging"]);
});

test("a table with nothing in common with the one it replaces reads as removed and added", () => {
  const before = "| Name | Size |\n| --- | --- |\n| a.png | 2 KB |\n";
  const after = "| Method | Path |\n| --- | --- |\n| GET | /items |\n";
  assert.deepEqual(summary(entries(before, after)), [
    "removed Name | Size / a.png | 2 KB",
    "added Method | Path / GET | /items",
  ]);
});

test("blocks after fences without a language keep their own lines", () => {
  const fence = (body: string) => `\`\`\`\n${body}\n\`\`\``;
  assert.deepEqual(
    entries("", `${fence("a")}\n\n${fence("b")}\n\nx\ny\nx\n`).map(({ lines }) => lines),
    [
      { side: "new", start: 0, end: 2 },
      { side: "new", start: 4, end: 6 },
      { side: "new", start: 8, end: 10 },
    ],
  );
});

test("front matter shows as code, leaving the document after it on its own lines", () => {
  assert.deepEqual(
    entries("", "---\ntitle: Guide\n---\n# Guide\n").map(({ block, lines }) => [content(block), lines]),
    [
      ["``` --- / title: Guide / ---", { side: "new", start: 0, end: 2 }],
      ["# Guide", { side: "new", start: 3, end: 3 }],
    ],
  );
});

test("a small edit to a long paragraph still marks only the words that changed", () => {
  const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
  const [entry] = entries(`${words} old.\n`, `${words} new.\n`);
  assert.equal(entry.change, "changed");
  assert.equal(marked(entry.block.kind === "text" ? entry.block.runs : []), `${words} [-old-]{+new+}.`);
});

test("a large code block compares quickly", () => {
  const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
  const edited = [...lines.slice(0, 10_000), "inserted", ...lines.slice(10_000)];
  const started = performance.now();
  const [entry] = entries(`\`\`\`\n${lines.join("\n")}\n\`\`\`\n`, `\`\`\`\n${edited.join("\n")}\n\`\`\`\n`);
  assert.ok(performance.now() - started < 2000);
  assert.deepEqual(
    entry.block.kind === "code" ? entry.block.lines.filter(({ change }) => change != null) : [],
    [{ text: "inserted", change: "added" }],
  );
});

test("renumbering a list leaves its items unchanged", () => {
  const list = (first: number) => Array.from({ length: 30 }, (_, i) => `${first + i}. item ${i}`).join("\n");
  const changes = entries(`${list(1)}\n`, `1. first\n${list(2)}\n`).map(({ change }) => change);
  assert.deepEqual(changes, ["added", ...Array<string>(30).fill("same")]);
});

test("an edited emoji stays whole", () => {
  assert.deepEqual(summary(entries("Ship it 😀 today.\n", "Ship it 😃 today.\n")), ["changed Ship it [-😀-]{+😃+} today."]);
});

test("nesting deep enough to overflow the parser says so instead of throwing", () => {
  assert.equal(markdownDiff("", `${">".repeat(100_000)} deep\n`).status, "unavailable");
});

test("rules, nested quotes and HTML render, and HTML comments don't", () => {
  const source = "> > Twice quoted.\n\n---\n\n<!-- hidden -->\n\n<details>\n<summary>More</summary>\n</details>\n";
  assert.deepEqual(summary(entries("", source)), [
    "added >> Twice quoted.",
    "added ---",
    "added ``` <details> / <summary>More</summary> / </details>",
  ]);
});

test("a rewritten code block reads as removed and added", () => {
  assert.deepEqual(summary(entries("```\nconst a = 1;\nconst b = 2;\n```\n", "```\nlet x = 9;\nlet y = 8;\n```\n")), [
    "removed ``` const a = 1; / const b = 2;",
    "added ``` let x = 9; / let y = 8;",
  ]);
});

test("removed table columns and rows, and rows rewritten under the same key", () => {
  const before = "| Name | Size | Notes |\n| --- | --- | --- |\n| a.png | 2 KB | logo |\n| b.png | 9 KB | old |\n";
  const after = "| Name | Size |\n| --- | --- |\n| a.png | 2048 bytes |\n";
  const [table] = entries(before, after);
  assert.deepEqual(table.block.kind === "table" ? table.block.columns.map(({ change }) => change) : [], [
    null,
    null,
    "removed",
  ]);
  assert.deepEqual(summary([table]), [
    "changed Name | Size | [-Notes-] / a.png | [-2 KB-]{+2048 bytes+} | [-logo-] / [-b.png | 9 KB | old-]",
  ]);
});

test("quotes, styles, links and entities come through as they render", () => {
  const [entry] = entries("", "> AT&amp;T **ships** [docs](https://x.test) and `a &amp; b`\n");
  assert.equal(entry.change, "added");
  assert.equal(entry.quote, 1);
  const runs = entry.block.kind === "text" ? entry.block.runs : [];
  assert.deepEqual(
    runs.map(({ text, strong, href, code }) => ({ text, strong, href, code })),
    [
      { text: "AT&T ", strong: false, href: null, code: false },
      { text: "ships", strong: true, href: null, code: false },
      { text: " ", strong: false, href: null, code: false },
      { text: "docs", strong: false, href: "https://x.test", code: false },
      { text: " and ", strong: false, href: null, code: false },
      { text: "a &amp; b", strong: false, href: null, code: true },
    ],
  );
});

test("emphasis, strikethrough, images, breaks and numeric entities come through as they render", () => {
  const [entry] = entries("", "*em* ~~gone~~ ![logo](a.png) line<br>next &#169;\n");
  const runs = entry.block.kind === "text" ? entry.block.runs : [];
  assert.deepEqual(
    runs.map(({ text, em, strike, image, href }) => ({ text, em, strike, image, href })),
    [
      { text: "em", em: true, strike: false, image: false, href: null },
      { text: " ", em: false, strike: false, image: false, href: null },
      { text: "gone", em: false, strike: true, image: false, href: null },
      { text: " ", em: false, strike: false, image: false, href: null },
      { text: "logo", em: false, strike: false, image: true, href: "a.png" },
      { text: " line\nnext ©", em: false, strike: false, image: false, href: null },
    ],
  );
});

test("a change only to how the source is written has nothing to show", () => {
  assert.equal(entries("", "Some *emphasis* here.\n").length, 1);
  assert.deepEqual(markdownDiff("Some *emphasis* here.\n<!-- note -->\n", "Some _emphasis_\nhere.\n"), {
    status: "unavailable",
    reason: "Only the markdown source changed, not how it reads.",
  });
});
