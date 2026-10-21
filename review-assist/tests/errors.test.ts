import assert from "node:assert/strict";
import test from "node:test";
import { detailsOf } from "../shared/errors";

test("an aggregate error's details include every error it gathers", () => {
  const details = detailsOf(
    new AggregateError([new Error("first cause"), "second cause"], "Encountered errors while disposing of store"),
  );
  assert.match(details, /^AggregateError: Encountered errors while disposing of store\n\s+at /);
  assert.match(details, /Caused by \(1 of 2\): Error: first cause\n\s+at /);
  assert.match(details, /Caused by \(2 of 2\): second cause$/);
});

test("a stack of frames only, as outside V8, is headed by the error's message", () => {
  const error = new Error("boom");
  error.stack = "f@x.js:1:1";
  assert.equal(detailsOf(error), "Error: boom\nf@x.js:1:1");
});
