import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createHandlers } from "./server/handlers";
import { EditorSessions } from "./server/sessions";
import {
  leaseRpc,
  listFilesRpc,
  lspRpc,
  readFileRpc,
  syncRpc,
  writeFileRpc,
} from "./shared/protocol";
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

  server.handle(listFilesRpc, (input, context) => editor(context).listFiles(input));
  server.handle(readFileRpc, (input, context) => editor(context).readFile(input));
  server.handle(writeFileRpc, (input, context) => editor(context).writeFile(input));
  server.handle(leaseRpc, (input, context) => editor(context).lease(input));
  server.handle(lspRpc, (input, context) => editor(context).lsp(input));
  server.handle(syncRpc, (input, context) => editor(context).sync(input));

  return async () => {
    await sessions?.dispose();
  };
}
