import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { sessionRpc } from "../shared/protocol";
import { serverSettingsSchema } from "../shared/settings";
import type { EditorSessions } from "./sessions";

export function createHandlers(sessions: EditorSessions) {
  return {
    async session({
      workspaceId,
      leaseId,
      action,
      settings,
    }: RpcInput<typeof sessionRpc>): Promise<RpcOutput<typeof sessionRpc>> {
      if (action === "release") {
        await sessions.release(leaseId);
        return { status: "released" };
      }
      try {
        const url = await sessions.hold(workspaceId, leaseId, settings ?? serverSettingsSchema.parse({}));
        return { status: "ready", url };
      } catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
