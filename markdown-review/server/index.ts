import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleReviews } from "../kit/server/handlers";
import { documentRpc } from "../shared/protocol";
import { locateDocument } from "./document";

export default function contribute(server: PluginServerContext): () => void {
  handleReviews(server, "markdown-review", async (directory) => directory);
  server.handle(documentRpc, ({ path }) => locateDocument(path));
  return () => {};
}
