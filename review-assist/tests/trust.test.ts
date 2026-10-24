import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { LanguageServers } from "../server/lsp/pool";
import { ProjectTrust } from "../server/trust";
import { fileRpc, leaseRpc, lspRpc, setTrustRpc, trustRpc } from "../shared/protocol";
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

test("the daemon serves language features only while the project is trusted", async () => {
  const repo = freshRepo();
  const worktree = freshRepo();
  writeIn(repo, "notes.txt", "plain\n");
  writeIn(worktree, "notes.txt", "plain\n");
  const { server, call } = fakeServer();
  const dispose = contribute(server);
  const hover = (projectId: string, root: string) =>
    call(lspRpc.name, { projectId, root, tree: null, path: "notes.txt", method: "textDocument/hover", params: {} });
  const refused = { status: "failed", error: "Language features are off until the project is trusted." };

  assert.deepEqual(await call(trustRpc.name, { projectId: "shelf" }), { trust: "undecided" });
  assert.deepEqual(await hover("shelf", repo), refused);
  assert.deepEqual(await call(setTrustRpc.name, { projectId: "shelf", trusted: true }), { trust: "trusted" });
  assert.deepEqual(await hover("shelf", repo), { status: "unsupported" });
  assert.deepEqual(await hover("shelf", worktree), { status: "unsupported" });
  assert.deepEqual(await hover("other", repo), refused);
  assert.deepEqual(await call(setTrustRpc.name, { projectId: "shelf", trusted: false }), { trust: "restricted" });
  assert.deepEqual(await hover("shelf", worktree), refused);
  await dispose();
});

test("untrusting a project stops the language servers of every root it was served at", async (t) => {
  const [repo, worktree, other, stranger] = [freshRepo(), freshRepo(), freshRepo(), freshRepo()];
  const stopped = t.mock.method(LanguageServers.prototype, "stop", async () => undefined);
  const { server, call } = fakeServer();
  const dispose = contribute(server);
  const hover = (projectId: string, root: string) =>
    call(lspRpc.name, { projectId, root, tree: null, path: "notes.txt", method: "textDocument/hover", params: {} });
  const hold = (projectId: string, root: string) =>
    call(leaseRpc.name, { projectId, root, leaseId: "lease", action: "hold" });
  const untrust = (projectId: string) => call(setTrustRpc.name, { projectId, trusted: false });
  const stops = () => stopped.mock.calls.map(({ arguments: [root] }) => root);

  await call(setTrustRpc.name, { projectId: "shelf", trusted: true });
  await call(setTrustRpc.name, { projectId: "other", trusted: true });
  await hover("shelf", repo);
  await hold("shelf", worktree);
  await hover("other", other);
  await hold("stranger", stranger);

  await untrust("shelf");
  assert.deepEqual(stops(), [repo, worktree]);
  await untrust("stranger");
  assert.deepEqual(stops(), [repo, worktree]);
  await untrust("other");
  assert.deepEqual(stops(), [repo, worktree, other]);
  stopped.mock.restore();
  await dispose();
});

test("projects start undecided, and the last decision for each stands", async () => {
  const trust = new ProjectTrust(scratchDirectory());
  assert.equal(await trust.read("shelf"), "undecided");
  assert.equal(await trust.allows("shelf"), false);
  assert.equal(await trust.read("constructor"), "undecided");

  await Promise.all([trust.decide("shelf", false), trust.decide("shelf", true), trust.decide("other", false)]);
  assert.equal(await trust.read("shelf"), "trusted");
  assert.equal(await trust.read("other"), "restricted");
  assert.equal(await trust.allows("shelf"), true);
  assert.equal(await trust.allows("other"), false);
});

test("decisions persist privately", async () => {
  const cache = scratchDirectory();
  await new ProjectTrust(cache).decide("shelf", true);
  const reloaded = new ProjectTrust(cache);
  assert.equal(await reloaded.read("shelf"), "trusted");
  assert.equal(await reloaded.allows("shelf"), true);
  assert.equal(statSync(join(cache, "trust.json")).mode & 0o777, 0o600);
});
