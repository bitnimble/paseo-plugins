import assert from "node:assert/strict";
import test from "node:test";
import { inflated } from "../client/inflate";
import { packed } from "../server/packed";
import { diffRpc, isDeflated } from "../shared/protocol";

test("small outputs travel as they are, large ones deflated and back intact through the contract", async () => {
  const failed = { status: "failed" as const, error: "No such directory" };
  assert.deepEqual(await packed(failed), failed);
  assert.deepEqual(diffRpc.output.parse(failed), failed);

  const raw = Array.from({ length: 5000 }, (_, i) => `+export const value${i} = "ünïcødé ${i}";`).join("\n");
  const ready = {
    status: "ready" as const,
    raw,
    hash: "h",
    base: { label: "main", sha: "abc" },
    root: "/repo",
    tree: "t",
    facts: { generated: {}, sizes: {}, lfs: [] },
  };
  const wire = diffRpc.output.parse(await packed(ready));
  assert.ok(isDeflated(wire));
  assert.ok(wire.deflated.length < JSON.stringify(ready).length / 4);
  assert.deepEqual(diffRpc.output.parse(JSON.parse(inflated(wire.deflated))), ready);
});
