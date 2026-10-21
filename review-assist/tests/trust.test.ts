import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { WorkspaceTrust } from "../server/trust";
import { fileRpc, lspRpc, setTrustRpc, trustRpc } from "../shared/protocol";
import { freshRepo, removeScratch, scratchDirectory, writeIn } from "./repo";

const cacheHome = process.env.XDG_CACHE_HOME;
process.env.XDG_CACHE_HOME = scratchDirectory();
after(() => {
  process.env.XDG_CACHE_HOME = cacheHome;
  removeScratch();
});

const NO_PASEO = {} as unknown as PluginHandlerContext["paseo"];

function fakeServer(): { server: PluginServerContext; call(name: string, input: unknown): Promise<unknown> } {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const server: PluginServerContext = {
    registerSettings: (definition) => ({
      read: async () => ({ status: "ready", revision: "", values: definition.schema.parse({}) }),
      subscribe: () => () => undefined,
    }),
    handle: (contract, handler) => {
      handlers.set(contract.name, async (input) => handler(await contract.input.parseAsync(input), { paseo: NO_PASEO }));
    },
    registerProvider: () => undefined,
    registerUsageSource: () => undefined,
    on: () => () => undefined,
    before: () => () => undefined,
  };
  const call = async (name: string, input: unknown): Promise<unknown> => {
    const handler = handlers.get(name);
    assert.ok(handler, name);
    return await handler(input);
  };
  return { server, call };
}

test("files are served only from a repository's top level", async () => {
  const repo = freshRepo();
  writeIn(repo, "notes.txt", "plain\n");
  const { server, call } = fakeServer();
  const dispose = contribute(server);
  const read = (root: string, path: string) => call(fileRpc.name, { root, tree: null, path });

  assert.deepEqual(await read(repo, "notes.txt"), { status: "ready", text: "plain\n" });
  assert.deepEqual(await read("/etc", "passwd"), { status: "failed", error: "Not a repository top level: /etc" });
  assert.deepEqual(await read(repo, "../../etc/passwd"), {
    status: "failed",
    error: "No language server reported ../../etc/passwd, and it is outside the repository",
  });
  await dispose();
});

test("the daemon serves language features only while the workspace is trusted", async () => {
  const repo = freshRepo();
  writeIn(repo, "notes.txt", "plain\n");
  const { server, call } = fakeServer();
  const dispose = contribute(server);
  const hover = () =>
    call(lspRpc.name, { root: repo, tree: null, path: "notes.txt", method: "textDocument/hover", params: {} });
  const refused = { status: "failed", error: "Language features are off until the workspace is trusted." };

  assert.deepEqual(await call(trustRpc.name, { directory: repo }), { trust: "undecided" });
  assert.deepEqual(await hover(), refused);
  assert.deepEqual(await call(setTrustRpc.name, { directory: repo, trusted: true }), { trust: "trusted" });
  assert.deepEqual(await hover(), { status: "unsupported" });
  assert.deepEqual(await call(setTrustRpc.name, { directory: repo, trusted: false }), { trust: "restricted" });
  assert.deepEqual(await hover(), refused);
  await dispose();
});

test("workspaces start undecided, and a root runs language servers while any trusted workspace has it", async () => {
  const cache = scratchDirectory();
  const trust = new WorkspaceTrust(cache);
  assert.equal(await trust.read("/work/a"), "undecided");
  assert.equal(await trust.allows("/repo"), false);

  await Promise.all([trust.decide("/work/a", "/repo", true), trust.decide("/work/b", "/repo", false)]);
  assert.equal(await trust.read("/work/a"), "trusted");
  assert.equal(await trust.read("/work/b"), "restricted");
  assert.equal(await trust.allows("/repo"), true);
  assert.equal(await trust.allows("/elsewhere"), false);

  await trust.decide("/work/a", "/repo", false);
  assert.equal(await trust.allows("/repo"), false);
});

test("decisions persist privately", async () => {
  const cache = scratchDirectory();
  await new WorkspaceTrust(cache).decide("/work/a", "/repo", true);
  const reloaded = new WorkspaceTrust(cache);
  assert.equal(await reloaded.read("/work/a"), "trusted");
  assert.equal(await reloaded.allows("/repo"), true);
  assert.equal(statSync(join(cache, "trust.json")).mode & 0o777, 0o600);
});
