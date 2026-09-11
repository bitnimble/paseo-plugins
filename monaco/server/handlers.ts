import { pathToFileURL } from "node:url";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { languageForPath } from "../shared/languages";
import type { leaseRpc, listFilesRpc, lspRpc, readFileRpc, syncRpc, writeFileRpc } from "../shared/protocol";
import { listWorkspaceFiles, readFileAt, resolveInside, writeFileAt } from "./files";
import type { LspSession } from "./lsp";
import type { EditorSessions } from "./sessions";

export function createHandlers(sessions: EditorSessions) {
  async function openedSession(
    workspaceId: string,
    path: string,
  ): Promise<{ session: LspSession; uri: string } | null> {
    const session = await sessions.sessionFor(workspaceId, path);
    const language = languageForPath(path);
    if (session == null || language == null) {
      return null;
    }
    const absolute = await sessions.resolve(workspaceId, path);
    const uri = pathToFileURL(absolute).href;
    if (!session.isOpen(uri)) {
      session.openDocument(uri, language.lspLanguageId, await readFileAt(absolute));
    }
    return { session, uri };
  }

  return {
    async listFiles({ workspaceId }: RpcInput<typeof listFilesRpc>): Promise<RpcOutput<typeof listFilesRpc>> {
      return await listWorkspaceFiles(await sessions.directoryFor(workspaceId));
    },

    async readFile({ workspaceId, path }: RpcInput<typeof readFileRpc>): Promise<RpcOutput<typeof readFileRpc>> {
      return { text: await readFileAt(await sessions.resolve(workspaceId, path)) };
    },

    async writeFile({
      workspaceId,
      path,
      text,
    }: RpcInput<typeof writeFileRpc>): Promise<RpcOutput<typeof writeFileRpc>> {
      const directory = await sessions.directoryFor(workspaceId);
      await writeFileAt(resolveInside(directory, path), text);
      return { written: true };
    },

    async lease({
      workspaceId,
      leaseId,
      action,
    }: RpcInput<typeof leaseRpc>): Promise<RpcOutput<typeof leaseRpc>> {
      if (action === "release") {
        return { leases: await sessions.release(workspaceId, leaseId) };
      }
      return { leases: sessions.acquire(workspaceId, leaseId) };
    },

    async lsp({
      workspaceId,
      path,
      method,
      params,
    }: RpcInput<typeof lspRpc>): Promise<RpcOutput<typeof lspRpc>> {
      try {
        const opened = await openedSession(workspaceId, path);
        if (opened == null) {
          return { status: "unsupported" };
        }
        const result = await opened.session.request(method, {
          ...params,
          textDocument: { uri: opened.uri },
        });
        sessions.recordReachable(workspaceId, result);
        return { status: "ok", result };
      } catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    },

    async sync({
      workspaceId,
      path,
      kind,
      text,
    }: RpcInput<typeof syncRpc>): Promise<RpcOutput<typeof syncRpc>> {
      if (kind === "close") {
        const session = await sessions.sessionFor(workspaceId, path);
        session?.closeDocument(pathToFileURL(await sessions.resolve(workspaceId, path)).href);
        return { synced: session != null };
      }
      const opened = await openedSession(workspaceId, path);
      if (opened == null) {
        return { synced: false };
      }
      if (kind === "save") {
        opened.session.saveDocument(opened.uri, text);
      } else {
        opened.session.changeDocument(opened.uri, text);
      }
      return { synced: true };
    },
  };
}
