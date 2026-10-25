import type { PluginServerContext } from "@getpaseo/plugin/server";
import { submitReview, workspaceAgents } from "./server/agents";
import { listBranches, previewBlob, readDiff, repoRoot } from "./server/git";
import { highlightSides, syntaxPalette } from "./server/highlight";
import { LanguageServers } from "./server/lsp/pool";
import { markdownDiff } from "./server/markdown";
import { MermaidRenderer } from "./server/mermaid/renderer";
import { monacoChunk } from "./server/monaco-assets";
import { handlePacked } from "./server/packed";
import { ReviewStates } from "./server/review-state";
import { cacheDirectory } from "./server/slots";
import { GuideStore } from "./server/store";
import { TreeFiles } from "./server/trees";
import { ProjectTrust } from "./server/trust";
import { PluginUpdates } from "./server/updates";
import { type Failed, failed } from "./shared/errors";
import {
  agentsRpc,
  blobRpc,
  branchesRpc,
  diffRpc,
  fileRpc,
  generateRpc,
  guideJobRpc,
  guideRpc,
  highlightRpc,
  leaseRpc,
  lspRpc,
  markdownRpc,
  mermaidRpc,
  monacoRpc,
  paletteRpc,
  setTrustRpc,
  stateChangeRpc,
  stateRpc,
  submitRpc,
  trustRpc,
  updateRpc,
  updateStatusRpc,
} from "./shared/protocol";
import { reviewSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext): () => Promise<void> {
  const settings = server.registerSettings(reviewSettings);
  const store = new GuideStore(cacheDirectory(), async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values.model : "";
  });
  const states = new ReviewStates(cacheDirectory());
  const trees = new TreeFiles();
  const languageServers = new LanguageServers(trees);
  const trust = new ProjectTrust(cacheDirectory());
  const projectOfServedRoot = new Map<string, string>();
  const mermaid = new MermaidRenderer();
  const updates = new PluginUpdates();
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
  handlePacked(server, guideRpc, async (input) => {
    const state = await store.read(input);
    if (state.guide != null) trees.remember(state.guide);
    return state;
  });
  server.handle(guideJobRpc, (input) => ({ job: store.job(input) }));
  server.handle(generateRpc, (input, { paseo }) => ({ job: store.generate(input, paseo) }));
  handlePacked(server, stateRpc, (input) => states.read(input));
  handlePacked(server, stateChangeRpc, ({ change, ...target }) => states.apply(target, change));
  server.handle(agentsRpc, async ({ workspaceId }, { paseo }) => ({ agents: await workspaceAgents(paseo, workspaceId) }));
  server.handle(submitRpc, (input, { paseo }) => submitReview(paseo, states, input));
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
  server.handle(paletteRpc, ({ scheme }) => ({ colors: syntaxPalette(scheme) }));
  handlePacked(server, monacoRpc, ({ asset, offset }) => monacoChunk(asset, offset));
  handlePacked(server, mermaidRpc, (input) => mermaid.draw(input));
  handlePacked(server, markdownRpc, ({ before, after }) => markdownDiff(before, after));
  server.handle(updateStatusRpc, () => updates.status());
  server.handle(updateRpc, () => {
    updates.install();
    return {};
  });
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
    mermaid.dispose();
    await languageServers.dispose();
  };
}
