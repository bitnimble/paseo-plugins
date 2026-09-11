import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createHandlers } from "./server/handlers";
import { EditorSessions } from "./server/sessions";
import { sessionRpc } from "./shared/protocol";
import { editorSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(editorSettings);

  let sessions: EditorSessions | null = null;
  let handlers: ReturnType<typeof createHandlers> | null = null;

  // The Paseo API arrives with the first RPC, not with the contribution call.
  function editor({ paseo }: PluginHandlerContext): ReturnType<typeof createHandlers> {
    if (handlers == null) {
      sessions = new EditorSessions(paseo);
      handlers = createHandlers(sessions);
    }
    return handlers;
  }

  server.handle(sessionRpc, (input, context) => editor(context).session(input));

  return async () => {
    await sessions?.dispose();
  };
}
