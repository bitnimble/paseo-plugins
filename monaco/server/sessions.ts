import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { languageForPath } from "../shared/languages";
import { isInside, resolveInside } from "./files";
import { LspSession } from "./lsp";
import { SERVER_COMMANDS } from "./servers";

const LEASE_TIMEOUT_MS = 90_000;
const SWEEP_INTERVAL_MS = 30_000;
const MAX_REACHABLE_PATHS = 5_000;

type PaseoApi = PluginHandlerContext["paseo"];

export class EditorSessions {
  private readonly leases = new Map<string, Map<string, number>>();
  private readonly servers = new Map<string, Map<string, Promise<LspSession>>>();
  private readonly directories = new Map<string, Promise<string>>();
  private readonly reachable = new Map<string, Set<string>>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly paseo: PaseoApi) {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  acquire(workspaceId: string, leaseId: string): number {
    let held = this.leases.get(workspaceId);
    if (held == null) {
      held = new Map();
      this.leases.set(workspaceId, held);
    }
    held.set(leaseId, Date.now());
    return held.size;
  }

  async release(workspaceId: string, leaseId: string): Promise<number> {
    const held = this.leases.get(workspaceId);
    if (held == null) {
      return 0;
    }
    held.delete(leaseId);
    if (held.size === 0) {
      this.leases.delete(workspaceId);
      await this.stopWorkspace(workspaceId);
    }
    return held.size;
  }

  directoryFor(workspaceId: string): Promise<string> {
    let pending = this.directories.get(workspaceId);
    if (pending == null) {
      pending = this.resolveDirectory(workspaceId);
      this.directories.set(workspaceId, pending);
      pending.catch(() => this.directories.delete(workspaceId));
    }
    return pending;
  }

  /**
   * The editor must follow a definition into a dependency or a toolchain source, so absolute paths
   * outside the workspace are readable; but only the ones a language server reported. A client
   * cannot name an arbitrary host path and have the daemon read it back.
   */
  async resolve(workspaceId: string, path: string): Promise<string> {
    const directory = await this.directoryFor(workspaceId);
    if (!isAbsolute(path)) {
      return resolveInside(directory, path);
    }
    const absolute = normalize(path);
    if (isInside(directory, absolute) || this.reachable.get(workspaceId)?.has(absolute) === true) {
      return absolute;
    }
    throw new Error(`No language server reported ${path}, and it is outside the workspace`);
  }

  recordReachable(workspaceId: string, result: unknown): void {
    let paths = this.reachable.get(workspaceId);
    if (paths == null) {
      paths = new Set();
      this.reachable.set(workspaceId, paths);
    }
    if (paths.size < MAX_REACHABLE_PATHS) {
      collectFilePaths(result, paths);
    }
  }

  async sessionFor(workspaceId: string, path: string): Promise<LspSession | null> {
    const language = languageForPath(path);
    const command = language == null ? null : SERVER_COMMANDS[language.serverId];
    if (language == null || command == null) {
      return null;
    }

    let byServer = this.servers.get(workspaceId);
    if (byServer == null) {
      byServer = new Map();
      this.servers.set(workspaceId, byServer);
    }

    const existing = byServer.get(language.serverId);
    if (existing != null) {
      return await existing;
    }
    // Registered before the first await: two requests arriving together must not each spawn a
    // server, leaving one untracked and impossible to shut down.
    const started = this.startSession(workspaceId, command);
    byServer.set(language.serverId, started);
    started.catch(() => {
      if (byServer.get(language.serverId) === started) {
        byServer.delete(language.serverId);
      }
    });
    return await started;
  }

  async dispose(): Promise<void> {
    clearInterval(this.sweeper);
    this.leases.clear();
    await Promise.all([...this.servers.keys()].map((workspaceId) => this.stopWorkspace(workspaceId)));
  }

  private async startSession(workspaceId: string, command: readonly string[]): Promise<LspSession> {
    return await LspSession.start(command, await this.directoryFor(workspaceId));
  }

  private async sweep(): Promise<void> {
    const deadline = Date.now() - LEASE_TIMEOUT_MS;
    for (const [workspaceId, held] of this.leases) {
      for (const [leaseId, lastSeen] of held) {
        if (lastSeen < deadline) {
          held.delete(leaseId);
        }
      }
      if (held.size === 0) {
        this.leases.delete(workspaceId);
        await this.stopWorkspace(workspaceId);
      }
    }
  }

  private async stopWorkspace(workspaceId: string): Promise<void> {
    const byServer = this.servers.get(workspaceId);
    this.servers.delete(workspaceId);
    this.directories.delete(workspaceId);
    this.reachable.delete(workspaceId);
    if (byServer == null) {
      return;
    }
    console.log(`[monaco] stopping ${String(byServer.size)} language server(s) for ${workspaceId}`);
    await Promise.all(
      [...byServer.values()].map(async (pending) => {
        const session = await pending.catch(() => null);
        await session?.dispose();
      }),
    );
  }

  private async resolveDirectory(workspaceId: string): Promise<string> {
    const workspace = this.paseo.workspaces.ref(workspaceId);
    const directory = workspace.directory ?? (await workspace.refresh())?.workspaceDirectory;
    if (directory == null) {
      throw new Error(`Workspace ${workspaceId} has no directory`);
    }
    return directory;
  }
}

function collectFilePaths(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFilePaths(item, into);
    }
    return;
  }
  if (typeof value !== "object" || value == null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "uri" || key === "targetUri") && typeof child === "string" && child.startsWith("file://")) {
      into.add(normalize(fileURLToPath(child)));
      continue;
    }
    collectFilePaths(child, into);
  }
}
