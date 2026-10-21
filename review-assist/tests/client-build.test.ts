import assert from "node:assert/strict";
import test from "node:test";
import { parseSync, traverse } from "@babel/core";
import { buildClient } from "../scripts/build-client.mjs";

test("the client entry the daemon compiles has no class syntax", async () => {
  const ast = parseSync(await buildClient(), { babelrc: false, configFile: false, sourceType: "module" });
  assert.ok(ast != null);
  const classes: string[] = [];
  traverse(ast, {
    Class(path) {
      classes.push(path.node.id?.name ?? "anonymous");
    },
  });
  assert.deepEqual(classes, []);
});
