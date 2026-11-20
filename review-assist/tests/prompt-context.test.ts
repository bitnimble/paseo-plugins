import assert from "node:assert/strict";
import test from "node:test";
import { type ContextLine, type PromptContextOptions, readPromptContext } from "../server/prompt-context";
import { parseDiff } from "../shared/diff";

const NEW_SHAPE = `class Shape {
  area(): number {
    return 0;
  }

  describe(
    prefix: string,
  ): string {
    const a = 1;
    const b = 2;
    const c = 3;
    const d = 4;
    return prefix + d;
  }
}
`;

const SHAPE_DIFF = parseDiff(`diff --git a/shape.ts b/shape.ts
index 1111111..2222222 100644
--- a/shape.ts
+++ b/shape.ts
@@ -12,3 +12,3 @@ class Shape {
     const d = 4;
-    return prefix;
+    return prefix + d;
   }
`);

const textOf = (lines: readonly ContextLine[] | undefined): string[] | undefined => lines?.map(({ text }) => text);

const contextFor = (options: PromptContextOptions) =>
  readPromptContext(SHAPE_DIFF, async (side, path) => (side === "new" && path === "shape.ts" ? NEW_SHAPE : ""), options);

test("a hunk gets the lines around it and the whole signatures of the declarations it sits in", async () => {
  const context = (await contextFor({ lines: 2, scope: true })).get("h0");

  assert.equal(context?.side, "new");
  assert.deepEqual(context?.scope, [
    { number: 1, text: "class Shape {" },
    { number: 6, text: "  describe(" },
    { number: 7, text: "    prefix: string," },
    { number: 8, text: "  ): string {" },
  ]);
  assert.deepEqual(context?.before, [
    { number: 10, text: "    const b = 2;" },
    { number: 11, text: "    const c = 3;" },
  ]);
  assert.deepEqual(context?.after, [{ number: 15, text: "}" }]);
});

const scopeOf = async (path: string, text: string, line: number): Promise<string[] | undefined> => {
  const changed = text.split(/\r?\n/)[line - 1];
  const diff = parseDiff(`diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -${line},1 +${line},1 @@
-${changed}x
+${changed}
`);
  return textOf((await readPromptContext(diff, async () => text, { lines: 0, scope: true })).get("h0")?.scope);
};

test("enclosing declarations come from each language's syntax tree", async () => {
  const python = `class Shape:
    @property
    def describe(
        self,
    ) -> str:
        if ready:
            return "shape"
`;
  assert.deepEqual(await scopeOf("shape.py", python, 7), [
    "class Shape:",
    "    def describe(",
    "        self,",
    "    ) -> str:",
  ]);

  const rust = `mod shapes {
    impl Shape {
        pub fn describe(&self) -> String {
            let name = self.name();
            name
        }
    }
}
`;
  assert.deepEqual(await scopeOf("shape.rs", rust, 5), [
    "mod shapes {",
    "    impl Shape {",
    "        pub fn describe(&self) -> String {",
  ]);

  const go = `package shapes

func (s *Shape) Describe() string {
	if s.ready {
		return "shape"
	}
	return ""
}
`;
  assert.deepEqual(await scopeOf("shape.go", go, 5), ["func (s *Shape) Describe() string {"]);
});

test("decorators and annotations don't take the place of the signature", async () => {
  const typescript = `export class Shape
  extends Base {
  @Input({
    required: true,
  })
  describe(): string {
    return "shape";
  }
}
`;
  assert.deepEqual(await scopeOf("shape.ts", typescript, 7), [
    "export class Shape",
    "  extends Base {",
    "  describe(): string {",
  ]);

  const java = `@Entity
public class Shape {
  @Override
  public String describe() {
    return "shape";
  }
}
`;
  assert.deepEqual(await scopeOf("Shape.java", java, 5), ["public class Shape {", "  public String describe() {"]);
});

test("CRLF files give the same headers without carriage returns", async () => {
  const crlf = NEW_SHAPE.replaceAll("\n", "\r\n");
  assert.deepEqual(await scopeOf("shape.ts", crlf, 13), [
    "class Shape {",
    "  describe(",
    "    prefix: string,",
    "  ): string {",
  ]);
});

test("a multi-line string or a language without a syntax tree gives no false headers", async () => {
  const template = `export function prompt(): string {
  return \`
Heading at column zero
  - item
\`;
}
`;
  assert.deepEqual(await scopeOf("prompt.ts", template, 4), ["export function prompt(): string {"]);
  assert.deepEqual(await scopeOf("notes.txt", "Heading\n  body\n    detail\n", 3), []);
});

test("a header among the hunk's own surrounding lines is left to them", async () => {
  const context = (await contextFor({ lines: 7, scope: true })).get("h0");

  assert.deepEqual(textOf(context?.scope), ["class Shape {"]);
  assert.equal(context?.before[1]?.text, "  describe(");
});

test("surrounding lines stop at a neighbouring hunk's own lines", async () => {
  const diff = parseDiff(`diff --git a/list.txt b/list.txt
index 1111111..2222222 100644
--- a/list.txt
+++ b/list.txt
@@ -2,1 +2,1 @@
-b
+B
@@ -4,1 +4,1 @@
-d
+D
`);
  const context = await readPromptContext(diff, async () => "a\nB\nc\nD\ne\n", { lines: 5, scope: false });

  assert.deepEqual(
    ["h0", "h1"].map((hunk) => [textOf(context.get(hunk)?.before), textOf(context.get(hunk)?.after)]),
    [
      [["a"], ["c"]],
      [["c"], ["e"]],
    ],
  );
});

test("a deleted file's context comes from its old side", async () => {
  const diff = parseDiff(`diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 1111111..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function gone(): void {
-  return;
-}
`);
  const reads: string[] = [];
  const context = await readPromptContext(
    diff,
    async (side, path) => {
      reads.push(`${side}:${path}`);
      return "export function gone(): void {\n  return;\n}\n";
    },
    { lines: 2, scope: true },
  );

  assert.deepEqual(reads, ["old:gone.ts"]);
  assert.deepEqual(context.get("h0"), { side: "old", scope: [], before: [], after: [] });
});

test("a file that can't be read gets no context, and both settings off read nothing", async () => {
  const unreadable = await readPromptContext(SHAPE_DIFF, async () => Promise.reject(new Error("gone")), {
    lines: 3,
    scope: true,
  });
  assert.equal(unreadable.size, 0);

  const off = await readPromptContext(SHAPE_DIFF, async () => assert.fail("read a file"), { lines: 0, scope: false });
  assert.equal(off.size, 0);
});
