import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { rangeLabel } from "../shared/comments";
import type { AgentChoice, DraftComment, Reviewer } from "../shared/protocol";
import type { Target } from "./slots";

type Paseo = PluginHandlerContext["paseo"];

const DEFAULT_MESSAGE = "Please address these review comments.";
const NEW_AGENT_TITLE = "Address review comments";

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
  input: Target & {
    reviewer: Reviewer;
    baseRef: string;
    message: string;
    comments: readonly DraftComment[];
    /** Suggestions already written to the working tree, named so the agent keeps them. */
    applied?: readonly DraftComment[];
  },
): Promise<void> {
  // Chat history keeps only the text, not attachments, so the comments go in both.
  const listed = input.comments.map((comment) => `- ${where(comment)}: ${comment.body.replaceAll("\n", "\n  ")}`);
  const applied = input.applied ?? [];
  const edits = applied.length === 0 ? [] : ["", "I've already made these edits myself:", ...applied.map((comment) => `- ${where(comment)}`)];
  const text = [input.message.trim() || DEFAULT_MESSAGE, "", ...listed, ...edits].join("\n");
  const attachment = {
    type: "review" as const,
    mimeType: "application/paseo-review" as const,
    cwd: input.directory,
    mode: input.mode.kind === "branch" ? ("base" as const) : ("uncommitted" as const),
    baseRef: input.mode.kind === "branch" ? input.baseRef : null,
    comments: input.comments.map((comment) => ({
      filePath: comment.filePath,
      side: comment.side,
      lineNumber: comment.lineNumber,
      // The attachment anchors one line, so a range says which lines it covers.
      body: comment.startLine === comment.lineNumber ? comment.body : `${rangeLabel(comment)}: ${comment.body}`,
      context: comment.context,
    })),
  };
  const { reviewer } = input;
  if (reviewer.kind === "agent") {
    await paseo.agents.ref(reviewer.id).send(text, { activeTurnBehavior: "steer", attachments: [attachment] });
    return;
  }
  await paseo.workspaces.ref(reviewer.workspaceId).agents.create({
    config: {
      provider: reviewer.model,
      ...(reviewer.modeId == null ? {} : { modeId: reviewer.modeId }),
      ...(reviewer.thinkingOptionId == null ? {} : { thinkingOptionId: reviewer.thinkingOptionId }),
    },
    title: NEW_AGENT_TITLE,
    prompt: text,
    attachments: [attachment],
  });
}

function where(comment: DraftComment): string {
  return `${comment.filePath} ${rangeLabel(comment).toLowerCase()}${comment.side === "old" ? " of the old file" : ""}`;
}
