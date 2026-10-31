import assert from "node:assert/strict";
import test from "node:test";
import { menuOffset } from "../client/menu-placement";

test("a menu that fits stays at its trigger", () => {
  assert.equal(menuOffset(100, 400, 248), 0);
});

test("a menu running past the right edge shifts left, keeping the gap", () => {
  assert.equal(menuOffset(320, 400, 248), -176);
});

test("a menu too wide for either side keeps the left edge on screen", () => {
  assert.equal(menuOffset(100, 200, 248), -92);
});
