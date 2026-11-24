import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleReviews } from "../kit/server/handlers";
import { handlePacked } from "../kit/server/packed";
import { repoRoot } from "../kit/server/repo";
import { cacheDirectory } from "../kit/server/slots";
import { type Failed, failed } from "../kit/shared/errors";
import {
  blobRpc,
  branchesRpc,
  diffRpc,
  difftasticStatusRpc,
  fileRpc,
  generateRpc,
  guideJobRpc,
  guideRpc,
  highlightRpc,
  leaseRpc,
  lspRpc,
  modeRpc,
  monacoRpc,
  peekRpc,
  setModeRpc,
  setTrustRpc,
  syntaxDiffRpc,
  trustRpc,
} from "../shared/protocol";
import { reviewSettings } from "../shared/settings";
import { Difftastic } from "./difftastic";
import { listBranches, previewBlob, readDiff } from "./git";
import { highlightSides } from "./highlight";
import { peek } from "./lsp/peek";
import { LanguageServers } from "./lsp/pool";
import { monacoChunk } from "./monaco-assets";
import { ReviewModes } from "./review-modes";
import { GuideStore } from "./store";
import { TreeFiles } from "./trees";
import { ProjectTrust } from "./trust";

const PLUGIN_ID = "review-assist";

export default function contribute(server: PluginServerContext): () => Promise<void> {
  const settings = server.registerSettings(reviewSettings);
  const cache = cacheDirectory(PLUGIN_ID);
  const store = new GuideStore(cache, async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : {};
  });
  const modes = new ReviewModes(cache);
  const difftastic = new Difftastic();
  const trees = new TreeFiles();
  const languageServers = new LanguageServers(trees);
  const trust = new ProjectTrust(cache);
  const projectOfServedRoot = new Map<string, string>();
  // Roots arrive from clients; only real repository top levels are served.
  const roots = new Set<string>();
  const rootRefusal = async (root: string): Promise<Failed | null> => {
    if (roots.has(root)) return null;
    if ((await repoRoot(root).catch(() => null)) !== root) return failed(`Not a repository top level: ${root}`);
    roots.add(root);
    return null;
  };
  const untrusted = failed("Language features are off until the project is trusted.");
  const languageRefusal = async (projectId: string, root: string): Promise<Failed | null> => {
    const refusal = (await rootRefusal(root)) ?? ((await trust.allows(projectId)) ? null : untrusted);
    if (refusal == null) projectOfServedRoot.set(root, projectId);
    return refusal;
  };

  handlePacked(server, diffRpc, ({ directory, mode }) =>
    readDiff(directory, mode).then((snapshot) => {
      roots.add(snapshot.root);
      trees.remember(snapshot);
      return { status: "ready" as const, ...snapshot };
    }, failed),
  );
  server.handle(branchesRpc, ({ directory }) => listBranches(directory));
  server.handle(difftasticStatusRpc, ({ recheck }) => difftastic.status(recheck));
  handlePacked(server, syntaxDiffRpc, ({ path, original, modified }) =>
    difftastic.diff(path, original, modified).then((diff) => ({ status: "ready" as const, diff }), failed),
  );
  server.handle(modeRpc, async ({ directory }) => ({ mode: await modes.read(directory) }));
  server.handle(setModeRpc, async ({ directory, mode }) => ({ mode: await modes.choose(directory, mode) }));
  handlePacked(server, guideRpc, async (input) => {
    const state = await store.read(input);
    if (state.guide != null) trees.remember(state.guide);
    return state;
  });
  server.handle(guideJobRpc, (input) => ({ job: store.job(input) }));
  server.handle(generateRpc, (input, { paseo }) => ({ job: store.generate(input, paseo) }));
  const stopReviews = handleReviews(server, PLUGIN_ID, repoRoot);
  handlePacked(server, fileRpc, async ({ root, tree, path }) =>
    (await rootRefusal(root)) ??
    (tree == null ? languageServers.readFile(root, path) : trees.read(root, tree, path)).then(
      (text) => ({ status: "ready" as const, text }),
      failed,
    ),
  );
  server.handle(
    blobRpc,
    async ({ root, tree, path, blob, lfs }) =>
      (await rootRefusal(root)) ?? previewBlob(root, tree, path, blob, lfs).catch(failed),
  );
  handlePacked(
    server,
    highlightRpc,
    async (input) => (await rootRefusal(input.root)) ?? highlightSides(trees, input).catch(failed),
  );
  handlePacked(server, monacoRpc, ({ asset, offset }) => monacoChunk(asset, offset));
  server.handle(trustRpc, async ({ projectId }) => ({ trust: await trust.read(projectId) }));
  server.handle(setTrustRpc, async ({ projectId, trusted }) => {
    const decided = await trust.decide(projectId, trusted);
    if (trusted) return { trust: decided };
    for (const [root, owner] of projectOfServedRoot) {
      if (owner !== projectId) continue;
      projectOfServedRoot.delete(root);
      await languageServers.stop(root);
    }
    return { trust: decided };
  });
  handlePacked(
    server,
    lspRpc,
    async ({ projectId, ...input }) =>
      (await languageRefusal(projectId, input.root)) ?? languageServers.request(input),
  );
  handlePacked(
    server,
    peekRpc,
    async ({ projectId, ...input }) =>
      (await languageRefusal(projectId, input.root)) ?? peek(languageServers, trees, input).catch(failed),
  );
  server.handle(leaseRpc, async ({ projectId, root, leaseId, action }) => {
    if (action === "release") {
      languageServers.release(root, leaseId);
      return {};
    }
    if ((await languageRefusal(projectId, root)) != null) return {};
    languageServers.hold(root, leaseId);
    return {};
  });
  return async () => {
    stopReviews();
    await languageServers.dispose();
  };
}
