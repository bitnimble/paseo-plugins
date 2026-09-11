import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ServerSettings } from "../shared/settings";
import { CodeServer } from "./server";

const LEASE_TIMEOUT_MS = 90_000;
const SWEEP_INTERVAL_MS = 30_000;

type PaseoApi = PluginHandlerContext["paseo"];

export class EditorSessions {
  private readonly leases = new Map<string, number>();
  private readonly directories = new Map<string, Promise<string>>();
  private readonly sweeper: NodeJS.Timeout;
  private server: Promise<CodeServer> | null = null;

  constructor(private readonly paseo: PaseoApi) {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  async hold(workspaceId: string, leaseId: string, settings: ServerSettings): Promise<string> {
    this.leases.set(leaseId, Date.now());
    const [server, folder] = await Promise.all([
      this.serverWith(settings),
      this.directoryFor(workspaceId),
    ]);
    return server.urlFor(folder);
  }

  async release(leaseId: string): Promise<void> {
    this.leases.delete(leaseId);
    if (this.leases.size === 0) {
      await this.stopServer();
    }
  }

  async dispose(): Promise<void> {
    clearInterval(this.sweeper);
    this.leases.clear();
    await this.stopServer();
  }

  private serverWith(settings: ServerSettings): Promise<CodeServer> {
    // Registered before the first await: two panels opening together share one server.
    this.server ??= CodeServer.start(settings);
    const started = this.server;
    started.catch(() => {
      if (this.server === started) {
        this.server = null;
      }
    });
    return started;
  }

  private async stopServer(): Promise<void> {
    const running = this.server;
    this.server = null;
    if (running == null) {
      return;
    }
    console.log("[editor] stopping the editor server");
    const server = await running.catch(() => null);
    await server?.dispose();
  }

  private async sweep(): Promise<void> {
    const deadline = Date.now() - LEASE_TIMEOUT_MS;
    for (const [leaseId, lastSeen] of this.leases) {
      if (lastSeen < deadline) {
        this.leases.delete(leaseId);
      }
    }
    if (this.leases.size === 0) {
      await this.stopServer();
    }
  }

  private directoryFor(workspaceId: string): Promise<string> {
    let pending = this.directories.get(workspaceId);
    if (pending == null) {
      pending = this.resolveDirectory(workspaceId);
      this.directories.set(workspaceId, pending);
      pending.catch(() => this.directories.delete(workspaceId));
    }
    return pending;
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
