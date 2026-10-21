import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { messageOf } from "../../shared/errors";
import type { TreeFiles } from "../trees";
import { LspSession } from "./session";
import { type ServerChoice, serverFor } from "./servers";

const LEASE_TIMEOUT_MS = 90_000;
const SWEEP_INTERVAL_MS = 30_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_REACHABLE_PATHS = 5_000;
const MAX_CACHED_BLOBS = 64;
const ACTIVITY_LEASE = "activity";

export interface LspCall {
  readonly root: string;
  /** Read the document from this tree, as the diff saw it; null reads it from disk. */
  readonly tree: string | null;
  /** Relative to `root`, or absolute for a file a language server pointed at. */
  readonly path: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type LspOutcome =
  | { readonly status: "ok"; readonly result: unknown }
  | { readonly status: "unsupported" }
  | { readonly status: "failed"; readonly error: string };

/** Shared by every panel and client of a root; stopped once no lease or call has touched it for a while. */
export class LanguageServers {
  private readonly leases = new Map<string, Map<string, number>>();
  private readonly sessions = new Map<string, Map<string, Promise<LspSession>>>();
  private readonly reachable = new Map<string, Set<string>>();
  private readonly blobs = new Map<string, Promise<string>>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly trees: TreeFiles) {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  hold(root: string, leaseId: string): void {
    let held = this.leases.get(root);
    if (held == null) {
      held = new Map();
      this.leases.set(root, held);
    }
    held.set(leaseId, Date.now());
  }

  release(root: string, leaseId: string): void {
    this.leases.get(root)?.delete(leaseId);
  }

  async request(call: LspCall): Promise<LspOutcome> {
    try {
      this.hold(call.root, ACTIVITY_LEASE);
      const absolute = this.resolve(call.root, call.path);
      const server = serverFor(call.root, absolute);
      if (server == null) {
        return { status: "unsupported" };
      }
      const session = await this.sessionFor(call.root, server);
      const text =
        call.tree == null || isAbsolute(call.path)
          ? await this.readDisk(call.root, absolute)
          : await this.readBlob(call.root, call.tree, call.path);
      const uri = pathToFileURL(absolute).href;
      session.sync(uri, server.languageId, text);
      const result = await session.request(call.method, { ...call.params, textDocument: { uri } });
      this.remember(call.root, result);
      return { status: "ok", result };
    } catch (error) {
      return { status: "failed", error: messageOf(error) };
    }
  }

  /** Also reads files outside `root` that a language server reported, never any other host path. */
  async readFile(root: string, path: string): Promise<string> {
    return await this.readDisk(root, this.resolve(root, path));
  }

  async stop(root: string): Promise<void> {
    const byServer = this.sessions.get(root);
    this.sessions.delete(root);
    this.leases.delete(root);
    this.reachable.delete(root);
    for (const key of this.blobs.keys()) {
      if (key.startsWith(`${root}\0`)) this.blobs.delete(key);
    }
    await Promise.all(
      [...(byServer?.values() ?? [])].map(async (pending) => (await pending.catch(() => null))?.dispose()),
    );
  }

  async dispose(): Promise<void> {
    clearInterval(this.sweeper);
    this.leases.clear();
    this.blobs.clear();
    await Promise.all([...this.sessions.keys()].map((root) => this.stop(root)));
  }

  private resolve(root: string, path: string): string {
    const absolute = normalize(isAbsolute(path) ? path : join(root, path));
    if (isInside(root, absolute) || this.reachable.get(root)?.has(absolute) === true) {
      return absolute;
    }
    throw new Error(`No language server reported ${path}, and it is outside the repository`);
  }

  private async readDisk(root: string, absolute: string): Promise<string> {
    const reported = this.reachable.get(root)?.has(absolute) === true;
    // A symlink inside the repository can point anywhere on the host.
    if (!reported && !isInside(await realpath(root), await realpath(absolute))) {
      throw new Error(`${absolute} resolves outside the repository`);
    }
    const { size } = await stat(absolute);
    if (size > MAX_FILE_BYTES) {
      throw new Error(`${absolute} is larger than ${MAX_FILE_BYTES} bytes`);
    }
    return await readFile(absolute, "utf8");
  }

  private async sessionFor(root: string, server: ServerChoice): Promise<LspSession> {
    let byServer = this.sessions.get(root);
    if (byServer == null) {
      byServer = new Map();
      this.sessions.set(root, byServer);
    }
    const existing = byServer.get(server.id);
    if (existing != null) {
      const session = await existing.catch(() => null);
      if (session?.running === true) return session;
      void session?.dispose();
      // Another request replaced the dead server, or stop() dropped this map: a server spawned into a
      // dropped map could never be stopped.
      if (byServer.get(server.id) !== existing || this.sessions.get(root) !== byServer) {
        return await this.sessionFor(root, server);
      }
    }
    // Registered before any await: two requests arriving together must not each spawn a server,
    // leaving one untracked and impossible to stop.
    const started = LspSession.start(server.command, root);
    byServer.set(server.id, started);
    started.catch(() => {
      if (byServer.get(server.id) === started) byServer.delete(server.id);
    });
    return await started;
  }

  private readBlob(root: string, tree: string, path: string): Promise<string> {
    const key = `${root}\0${tree}\0${path}`;
    let text = this.blobs.get(key);
    if (text == null) {
      if (this.blobs.size >= MAX_CACHED_BLOBS) this.blobs.clear();
      text = this.trees.read(root, tree, path);
      this.blobs.set(key, text);
      text.catch(() => this.blobs.delete(key));
    }
    return text;
  }

  private remember(root: string, result: unknown): void {
    let paths = this.reachable.get(root);
    if (paths == null) {
      paths = new Set();
      this.reachable.set(root, paths);
    }
    if (paths.size < MAX_REACHABLE_PATHS) {
      collectFilePaths(result, paths);
    }
  }

  private async sweep(): Promise<void> {
    const deadline = Date.now() - LEASE_TIMEOUT_MS;
    for (const root of new Set([...this.sessions.keys(), ...this.leases.keys()])) {
      const held = this.leases.get(root);
      for (const [leaseId, lastSeen] of held ?? []) {
        if (lastSeen < deadline) held?.delete(leaseId);
      }
      if (held == null || held.size === 0) {
        await this.stop(root);
      }
    }
  }
}

function isInside(directory: string, absolute: string): boolean {
  return absolute === directory || absolute.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`);
}

function collectFilePaths(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFilePaths(item, into);
    return;
  }
  if (typeof value !== "object" || value == null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "uri" || key === "targetUri") && typeof child === "string" && child.startsWith("file://")) {
      const path = filePathOf(child);
      if (path != null) into.add(normalize(path));
      continue;
    }
    collectFilePaths(child, into);
  }
}

/** Null for a file URL with a host or an encoded slash, which `fileURLToPath` rejects. */
function filePathOf(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}
