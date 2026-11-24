import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  agentsRpc,
  markdownRpc,
  mermaidDrawRpc,
  mermaidRpc,
  paletteRpc,
  stateChangeRpc,
  stateRpc,
  submitRpc,
  updateRpc,
  updateStatusRpc,
} from "../shared/protocol";
import { submitReview, workspaceAgents } from "./agents";
import { syntaxPalette } from "./highlight";
import { markdownDiff } from "./markdown";
import { MermaidRenderer } from "./mermaid/renderer";
import { handlePacked } from "./packed";
import { ReviewStates } from "./review-state";
import { cacheDirectory } from "./slots";
import { PluginUpdates } from "./updates";

/** `rootOf` is the directory a review target's comment paths are relative to; call the returned stop when the plugin stops. */
export function handleReviews(
  server: PluginServerContext,
  pluginId: string,
  rootOf: (directory: string) => Promise<string>,
): () => void {
  const states = new ReviewStates(cacheDirectory(pluginId));
  const updates = new PluginUpdates(pluginId);
  const mermaid = new MermaidRenderer();
  handlePacked(server, stateRpc, (input) => states.read(input));
  handlePacked(server, stateChangeRpc, ({ change, ...target }) => states.apply(target, change));
  server.handle(agentsRpc, async ({ workspaceId }, { paseo }) => ({ agents: await workspaceAgents(paseo, workspaceId) }));
  server.handle(submitRpc, (input, { paseo }) => submitReview(paseo, states, input, rootOf));
  handlePacked(server, markdownRpc, ({ before, after }) => markdownDiff(before, after));
  handlePacked(server, mermaidRpc, (input) => mermaid.draw({ kind: "diff", ...input }));
  handlePacked(server, mermaidDrawRpc, (input) => mermaid.draw({ kind: "draw", ...input }));
  server.handle(paletteRpc, ({ scheme }) => ({ colors: syntaxPalette(scheme) }));
  server.handle(updateStatusRpc, () => updates.status());
  server.handle(updateRpc, () => {
    updates.install();
    return {};
  });
  return () => mermaid.dispose();
}
