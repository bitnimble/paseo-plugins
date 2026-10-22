import assert from "node:assert/strict";
import { test } from "node:test";
import { resultOf, statusOf } from "../server/updates";

const git = (outcome: string, extra: object = {}) =>
  JSON.stringify([
    {
      id: "review-assist",
      outcome,
      current: { currentRevision: "1e4ecfbb0d300ae13d211bc93b269f4a21eae85e" },
      target: { kind: "git", commit: "93d57da38fcf7e990544131f82b3c14c5569d523" },
      links: ["https://github.com/bitnimble/paseo-plugins/compare/1e4ecfb...93d57da"],
      ...extra,
    },
  ]);

test("an available update names both revisions and links to the changes", () => {
  assert.deepEqual(statusOf(git("update")), {
    status: "available",
    current: "1e4ecfb",
    target: "93d57da",
    review: "https://github.com/bitnimble/paseo-plugins/compare/1e4ecfb...93d57da",
    failure: null,
  });
});

test("names npm versions as they are", () => {
  const npm = JSON.stringify([
    { outcome: "update", current: { currentRevision: "1.2.0" }, target: { kind: "npm", version: "1.3.0" }, links: [] },
  ]);
  assert.deepEqual(statusOf(npm), { status: "available", current: "1.2.0", target: "1.3.0", review: null, failure: null });
});

test("an install at or past its source is up to date", () => {
  assert.deepEqual(statusOf(git("current")), { status: "current", revision: "1e4ecfb" });
  assert.deepEqual(statusOf(git("installed-newer")), { status: "current", revision: "1e4ecfb" });
});

test("explains installs it can't update", () => {
  assert.deepEqual(statusOf(git("local")), {
    status: "unavailable",
    reason: "Installed from a local folder, which has no source to update from.",
  });
  assert.deepEqual(statusOf(git("error", { error: "fetch failed" })), { status: "unavailable", reason: "fetch failed" });
  assert.deepEqual(statusOf("[]"), { status: "unavailable", reason: "Paseo has no record of this plugin." });
});

test("reports how an update went", () => {
  assert.equal(resultOf(JSON.stringify([{ id: "review-assist", outcome: "updated" }])), null);
  assert.equal(resultOf(JSON.stringify([{ id: "review-assist", outcome: "error", error: "build failed" }])), "build failed");
});
