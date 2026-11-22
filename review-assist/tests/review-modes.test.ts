import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ReviewModes } from "../server/review-modes";
import { DEFAULT_BRANCH_MODE, UNCOMMITTED_MODE } from "../shared/protocol";
import { removeScratch, scratchDirectory } from "./repo";

after(removeScratch);

test("a workspace's mode is unset until picked, then kept per directory for every reader", async () => {
  const cache = scratchDirectory();
  const modes = new ReviewModes(cache);

  assert.equal(await modes.read("/work/a"), null);
  await modes.choose("/work/a", UNCOMMITTED_MODE);
  await modes.choose("/work/b", { kind: "branch", branch: "release" });
  await modes.choose("/work/a", DEFAULT_BRANCH_MODE);

  const restarted = new ReviewModes(cache);
  assert.deepEqual(await restarted.read("/work/a"), DEFAULT_BRANCH_MODE);
  assert.deepEqual(await restarted.read("/work/b"), { kind: "branch", branch: "release" });
});
