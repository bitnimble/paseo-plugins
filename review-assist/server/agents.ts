import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { rangeLabel } from "../shared/comments";
import type { AgentChoice, DraftComment } from "../shared/protocol";
import type { Target } from "./slots";

type Paseo = PluginHandlerContext["paseo"];

const DEFAULT_MESSAGE = "Please address these review comments.";

export async function workspaceAgents(paseo: Paseo, workspaceId: string): Promise<AgentChoice[]> {
  const { entries } = await paseo.agents.list();
  return entries
    .map(({ agent }) => agent)
    .filter(
      (agent) =>
        agent.workspaceId === workspaceId && agent.archivedAt == null && agent.labels["review-assist"] == null,
    )
    .sort((a, b) => (b.lastUserMessageAt ?? b.updatedAt).localeCompare(a.lastUserMessageAt ?? a.updatedAt))
    .map(({ id, title, provider, status }) => ({ id, title, provider, status }));
}

/** As Paseo's own Changes panel sends them, so the agent reads them the same way. */
export async function sendReview(
  paseo: Paseo,
  input: Target & { agentId: string; baseRef: string; message: string; comments: readonly DraftComment[] },
): Promise<void> {
  await paseo.agents.ref(input.agentId).send(input.message.trim() || DEFAULT_MESSAGE, {
    activeTurnBehavior: "steer",
    attachments: [
      {
        type: "review",
        mimeType: "application/paseo-review",
        cwd: input.directory,
        mode: input.mode.kind === "branch" ? "base" : "uncommitted",
        baseRef: input.mode.kind === "branch" ? input.baseRef : null,
        comments: input.comments.map((comment) => ({
          filePath: comment.filePath,
          side: comment.side,
          lineNumber: comment.lineNumber,
          // The attachment anchors one line, so a range says which lines it covers.
          body: comment.startLine === comment.lineNumber ? comment.body : `${rangeLabel(comment)}: ${comment.body}`,
          context: comment.context,
        })),
      },
    ],
  });
}
