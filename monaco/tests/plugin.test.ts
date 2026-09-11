import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodeServer, splitArgs } from "../server/server.ts";
import { serverSettingsSchema } from "../shared/settings.ts";

const FAKE_SERVER = fileURLToPath(new URL("fake-server.mjs", import.meta.url));

function settings(overrides: Partial<ReturnType<typeof serverSettingsSchema.parse>> = {}) {
  return { ...serverSettingsSchema.parse({}), ...overrides };
}

test("settings default to a usable local server", () => {
  const defaults = serverSettingsSchema.parse({});
  assert.equal(defaults.command, "openvscode-server");
  assert.equal(defaults.bindHost, "127.0.0.1");
  assert.equal(defaults.publicUrl, "");
});

test("extra arguments split on whitespace and tolerate padding", () => {
  assert.deepEqual(splitArgs("  --extensions-dir  /tmp/ext   "), ["--extensions-dir", "/tmp/ext"]);
  assert.deepEqual(splitArgs("   "), []);
});

test("a missing binary fails fast instead of waiting out the readiness timeout", async () => {
  const started = Date.now();
  await assert.rejects(CodeServer.start(settings({ command: "definitely-not-a-real-editor-server" })));
  assert.ok(Date.now() - started < 10_000, "should reject on spawn failure, not on the ready timeout");
});

test("the frame URL carries the folder and connection token", async () => {
  const server = await CodeServer.start(settings({ command: FAKE_SERVER }));
  try {
    const url = new URL(server.urlFor("/home/me/project"));
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.searchParams.get("folder"), "/home/me/project");
    assert.match(url.searchParams.get("tkn") ?? "", /^[0-9a-f-]{36}$/);
  } finally {
    await server.dispose();
  }
});

test("a public URL replaces the local origin but keeps the query", async () => {
  const server = await CodeServer.start(
    settings({ command: FAKE_SERVER, publicUrl: "https://editor.example.com/" }),
  );
  try {
    const url = new URL(server.urlFor("/srv/app"));
    assert.equal(url.origin, "https://editor.example.com");
    assert.equal(url.searchParams.get("folder"), "/srv/app");
  } finally {
    await server.dispose();
  }
});
