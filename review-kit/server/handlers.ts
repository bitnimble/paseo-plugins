import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  agentsRpc,
  markdownRpc,
  stateChangeRpc,
  stateRpc,
  submitRpc,
  updateRpc,
  updateStatusRpc,
} from "../shared/protocol";
import { submitReview, workspaceAgents } from "./agents";
import { markdownDiff } from "./markdown";
import { handlePacked } from "./packed";
import { ReviewStates } from "./review-state";
import { cacheDirectory } from "./slots";
import { PluginUpdates } from "./updates";

/**
 * Serves the kit's contracts: comments and viewed marks, sending them, rendered markdown and updates.
 * `rootOf` is the directory a review target's comment paths are relative to.
 */
export function handleReviews(
  server: PluginServerContext,
  pluginId: string,
  rootOf: (directory: string) => Promise<string>,
): void {
  const states = new ReviewStates(cacheDirectory(pluginId));
  const updates = new PluginUpdates(pluginId);
  handlePacked(server, stateRpc, (input) => states.read(input));
  handlePacked(server, stateChangeRpc, ({ change, ...target }) => states.apply(target, change));
  server.handle(agentsRpc, async ({ workspaceId }, { paseo }) => ({ agents: await workspaceAgents(paseo, workspaceId) }));
  server.handle(submitRpc, (input, { paseo }) => submitReview(paseo, states, input, rootOf));
  handlePacked(server, markdownRpc, ({ before, after }) => markdownDiff(before, after));
  server.handle(updateStatusRpc, () => updates.status());
  server.handle(updateRpc, () => {
    updates.install();
    return {};
  });
}
