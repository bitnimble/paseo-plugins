import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodeServer } from "../server/server.ts";
import { serverSettingsSchema } from "../shared/settings.ts";

/** Set OPENVSCODE_SERVER to an unpacked build to run these against the real thing. */
const command = process.env["OPENVSCODE_SERVER"] ?? resolveOnPath();
const skip = command == null ? "openvscode-server is not installed" : false;

function resolveOnPath(): string | null {
  try {
    return execFileSync("which", ["openvscode-server"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function startServer(): Promise<CodeServer> {
  const dataDir = await mkdtemp(join(tmpdir(), "editor-data-"));
  return await CodeServer.start({
    ...serverSettingsSchema.parse({}),
    command: command ?? "",
    extraArgs: `--server-data-dir ${dataDir}`,
  });
}

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

test("the real editor server opens the workspace folder and enforces its token", { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "editor-live-"));
  await writeFile(join(directory, "app.ts"), "export const answer = 42;\n");

  const server = await startServer();
  try {
    const url = new URL(server.urlFor(directory));
    assert.equal(url.searchParams.get("folder"), directory);

    // The token is traded for a cookie on the first hit, so the browser lands on the workbench.
    const authorized = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    assert.equal(authorized.status, 302);
    assert.match(authorized.headers.get("set-cookie") ?? "", /vscode-tkn=/);

    const withoutToken = new URL(url);
    withoutToken.searchParams.delete("tkn");
    const rejected = await fetch(withoutToken, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(rejected.status, 403);
  } finally {
    await server.dispose();
  }
});

test("disposing stops the server process, not just its launcher script", { skip }, async () => {
  const server = await startServer();
  const { port, hostname } = new URL(server.urlFor("/tmp"));
  assert.equal(await accepts(hostname, Number(port)), true);

  await server.dispose();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await accepts(hostname, Number(port)))) {
      return;
    }
  }
  assert.fail("the editor server was still listening after dispose");
});
