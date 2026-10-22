import type { PluginServerContext } from "@getpaseo/plugin/server";
import { sendReview, workspaceAgents } from "./server/agents";
import { listBranches, previewBlob, readDiff, repoRoot } from "./server/git";
import { highlightSides, syntaxPalette } from "./server/highlight";
import { LanguageServers } from "./server/lsp/pool";
import { MermaidRenderer } from "./server/mermaid/renderer";
import { monacoChunk } from "./server/monaco-assets";
import { ReviewStates } from "./server/review-state";
import { messageOf } from "./shared/errors";
import { cacheDirectory } from "./server/slots";
import { GuideStore } from "./server/store";
import { TreeFiles } from "./server/trees";
import { WorkspaceTrust } from "./server/trust";
import { PluginUpdates } from "./server/updates";
import {
  agentsRpc,
  blobRpc,
  branchesRpc,
  commentRpc,
  diffRpc,
  fileRpc,
  generateRpc,
  guideRpc,
  highlightRpc,
  leaseRpc,
  lspRpc,
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
  const trust = new WorkspaceTrust(cacheDirectory());
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
  const untrusted = { status: "failed" as const, error: "Language features are off until the workspace is trusted." };
  const failed = (error: unknown) => ({ status: "failed" as const, error: messageOf(error) });

  server.handle(diffRpc, ({ directory, mode }) =>
    readDiff(directory, mode).then((snapshot) => {
      roots.add(snapshot.root);
      trees.remember(snapshot);
      return { status: "ready" as const, ...snapshot };
    }, failed),
  );
  server.handle(branchesRpc, ({ directory }) => listBranches(directory));
  server.handle(guideRpc, async (input) => {
    const state = await store.read(input);
    if (state.guide != null) trees.remember(state.guide);
    return state;
  });
  server.handle(generateRpc, (input, { paseo }) => ({ job: store.generate(input, paseo) }));
  server.handle(stateRpc, (input) => states.read(input));
  server.handle(viewedRpc, ({ path, fingerprint, viewed, ...target }) =>
    states.setViewed(target, { path, fingerprint }, viewed),
  );
  server.handle(commentRpc, ({ change, ...target }) =>
    change.action === "save" ? states.saveComment(target, change.comment) : states.deleteComments(target, [change.id]),
  );
  server.handle(agentsRpc, async ({ workspaceId }, { paseo }) => ({ agents: await workspaceAgents(paseo, workspaceId) }));
  server.handle(submitRpc, async ({ commentIds, ...input }, { paseo }) => {
    const comments = (await states.read(input)).comments.filter(({ id }) => commentIds.includes(id));
    if (comments.length === 0) return { status: "failed" as const, error: "These comments were already sent or deleted." };
    try {
      await sendReview(paseo, { ...input, comments });
    } catch (error) {
      return failed(error);
    }
    return { status: "sent" as const, state: await states.deleteComments(input, commentIds) };
  });
  server.handle(fileRpc, async ({ root, tree, path }) => {
    if (!(await admit(root))) return unknownRoot(root);
    return (tree == null ? languageServers.readFile(root, path) : trees.read(root, tree, path)).then(
      (text) => ({ status: "ready" as const, text }),
      failed,
    );
  });
  server.handle(blobRpc, async ({ root, tree, path, blob }) => {
    if (!(await admit(root))) return unknownRoot(root);
    return previewBlob(root, tree, path, blob).catch(failed);
  });
  server.handle(highlightRpc, async (input) => {
    if (!(await admit(input.root))) return unknownRoot(input.root);
    return highlightSides(trees, input).catch(failed);
  });
  server.handle(paletteRpc, ({ scheme }) => ({ colors: syntaxPalette(scheme) }));
  server.handle(monacoRpc, ({ asset, offset }) => monacoChunk(asset, offset));
  server.handle(mermaidRpc, (input) => mermaid.draw(input));
  server.handle(updateStatusRpc, () => updates.status());
  server.handle(updateRpc, () => {
    updates.install();
    return {};
  });
  server.handle(trustRpc, async ({ directory }) => ({ trust: await trust.read(directory) }));
  server.handle(setTrustRpc, async ({ directory, trusted }) => {
    const root = await repoRoot(directory);
    const decided = await trust.decide(directory, root, trusted);
    if (!(await trust.allows(root))) await languageServers.stop(root);
    return { trust: decided };
  });
  server.handle(lspRpc, async (input) => {
    if (!(await admit(input.root))) return unknownRoot(input.root);
    return (await trust.allows(input.root)) ? languageServers.request(input) : untrusted;
  });
  server.handle(leaseRpc, async ({ root, leaseId, action }) => {
    if (action === "release") languageServers.release(root, leaseId);
    else if ((await admit(root)) && (await trust.allows(root))) languageServers.hold(root, leaseId);
    return {};
  });
  return async () => {
    mermaid.dispose();
    await languageServers.dispose();
  };
}
