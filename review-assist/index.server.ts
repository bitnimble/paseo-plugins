import type { PluginServerContext } from "@getpaseo/plugin/server";
import { submitReview, workspaceAgents } from "./server/agents";
import { listBranches, previewBlob, readDiff, repoRoot } from "./server/git";
import { highlightSides, syntaxPalette } from "./server/highlight";
import { LanguageServers } from "./server/lsp/pool";
import { markdownDiff } from "./server/markdown";
import { MermaidRenderer } from "./server/mermaid/renderer";
import { monacoChunk } from "./server/monaco-assets";
import { packed } from "./server/packed";
import { ReviewStates } from "./server/review-state";
import { cacheDirectory } from "./server/slots";
import { GuideStore } from "./server/store";
import { TreeFiles } from "./server/trees";
import { ProjectTrust } from "./server/trust";
import { PluginUpdates } from "./server/updates";
import { messageOf } from "./shared/errors";
import {
  agentsRpc,
  blobRpc,
  branchesRpc,
  commentRpc,
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
  stateRpc,
  submitRpc,
  trustRpc,
  updateRpc,
  updateStatusRpc,
  viewedRpc,
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
  const admit = async (root: string): Promise<boolean> => {
    if (roots.has(root)) return true;
    if ((await repoRoot(root).catch(() => null)) !== root) return false;
    roots.add(root);
    return true;
  };
  const unknownRoot = (root: string) => ({ status: "failed" as const, error: `Not a repository top level: ${root}` });
  const untrusted = { status: "failed" as const, error: "Language features are off until the project is trusted." };
  const failed = (error: unknown) => ({ status: "failed" as const, error: messageOf(error) });

  server.handle(diffRpc, ({ directory, mode }) =>
    readDiff(directory, mode)
      .then((snapshot) => {
        roots.add(snapshot.root);
        trees.remember(snapshot);
        return { status: "ready" as const, ...snapshot };
      }, failed)
      .then(packed),
  );
  server.handle(branchesRpc, ({ directory }) => listBranches(directory));
  server.handle(guideRpc, async (input) => {
    const state = await store.read(input);
    if (state.guide != null) trees.remember(state.guide);
    return packed(state);
  });
  server.handle(guideJobRpc, (input) => ({ job: store.job(input) }));
  server.handle(generateRpc, (input, { paseo }) => ({ job: store.generate(input, paseo) }));
  server.handle(stateRpc, (input) => states.read(input).then(packed));
  server.handle(viewedRpc, ({ path, fingerprint, viewed, ...target }) =>
    states.setViewed(target, { path, fingerprint }, viewed).then(packed),
  );
  server.handle(commentRpc, ({ change, ...target }) =>
    (change.action === "save"
      ? states.saveComment(target, change.comment)
      : states.deleteComments(target, [change.id])
    ).then(packed),
  );
  server.handle(agentsRpc, async ({ workspaceId }, { paseo }) => ({ agents: await workspaceAgents(paseo, workspaceId) }));
  server.handle(submitRpc, (input, { paseo }) => submitReview(paseo, states, input));
  server.handle(fileRpc, async ({ root, tree, path }) => {
    if (!(await admit(root))) return unknownRoot(root);
    return (tree == null ? languageServers.readFile(root, path) : trees.read(root, tree, path))
      .then((text) => ({ status: "ready" as const, text }), failed)
      .then(packed);
  });
  server.handle(blobRpc, async ({ root, tree, path, blob, lfs }) => {
    if (!(await admit(root))) return unknownRoot(root);
    return previewBlob(root, tree, path, blob, lfs).catch(failed);
  });
  server.handle(highlightRpc, async (input) => {
    if (!(await admit(input.root))) return unknownRoot(input.root);
    return highlightSides(trees, input).catch(failed).then(packed);
  });
  server.handle(paletteRpc, ({ scheme }) => ({ colors: syntaxPalette(scheme) }));
  server.handle(monacoRpc, async ({ asset, offset }) => packed(await monacoChunk(asset, offset)));
  server.handle(mermaidRpc, async (input) => packed(await mermaid.draw(input)));
  server.handle(markdownRpc, async ({ before, after }) => packed(await markdownDiff(before, after)));
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
  server.handle(lspRpc, async ({ projectId, ...input }) => {
    if (!(await admit(input.root))) return unknownRoot(input.root);
    if (!(await trust.allows(projectId))) return untrusted;
    projectOfServedRoot.set(input.root, projectId);
    return packed(await languageServers.request(input));
  });
  server.handle(leaseRpc, async ({ projectId, root, leaseId, action }) => {
    if (action === "release") {
      languageServers.release(root, leaseId);
      return {};
    }
    if (!(await admit(root)) || !(await trust.allows(projectId))) return {};
    projectOfServedRoot.set(root, projectId);
    languageServers.hold(root, leaseId);
    return {};
  });
  return async () => {
    mermaid.dispose();
    await languageServers.dispose();
  };
}
