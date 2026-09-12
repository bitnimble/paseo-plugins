import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { connect, createServer } from "node:net";
import type { ServerSettings } from "../shared/settings";
import { Tunnel } from "./tunnel";

const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 250;
const KILL_GRACE_MS = 5_000;

export class CodeServer {
  private stopped = false;

  private tunnel: Tunnel | null = null;

  private constructor(
    private readonly child: ChildProcess,
    private readonly settings: ServerSettings,
    private readonly port: number,
    private readonly token: string,
    private readonly basePath: string,
  ) {}

  static async start(settings: ServerSettings): Promise<CodeServer> {
    const command = settings.command.trim().length > 0 ? settings.command.trim() : "openvscode-server";
    const port = settings.port === 0 ? await freePort(settings.bindHost) : settings.port;
    const token = randomUUID();
    // A second secret at the edge: everything outside this path answers 403, so a scanner that
    // finds the tunnel hostname never reaches the editor, let alone its token.
    const basePath = randomBytes(24).toString("base64url");
    const args = [
      "--host",
      settings.bindHost,
      "--port",
      String(port),
      "--connection-token",
      token,
      "--server-base-path",
      `/${basePath}`,
      ...splitArgs(settings.extraArgs),
    ];

    // Own process group: the launcher is a shell script that execs node, so signalling only the
    // child leaves the real server running and holding these pipes open.
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stdout?.on("data", (chunk: Buffer) => console.log(`[editor] ${chunk.toString("utf8").trimEnd()}`));
    child.stderr?.on("data", (chunk: Buffer) => console.error(`[editor] ${chunk.toString("utf8").trimEnd()}`));

    const server = new CodeServer(child, settings, port, token, basePath);
    try {
      await server.waitUntilListening();
      await server.openTunnel();
    } catch (error) {
      await server.dispose();
      throw error;
    }
    return server;
  }

  urlFor(folder: string): string {
    const query = `tkn=${encodeURIComponent(this.token)}&folder=${encodeURIComponent(folder)}`;
    return `${this.origin()}/${this.basePath}/?${query}`;
  }

  private origin(): string {
    const configured = this.settings.publicUrl.trim();
    if (configured.length > 0) {
      return configured.replace(/\/+$/, "");
    }
    if (this.tunnel != null) {
      return this.tunnel.origin.replace(/\/+$/, "");
    }
    return `http://${reachableHost(this.settings.bindHost)}:${String(this.port)}`;
  }

  private async openTunnel(): Promise<void> {
    const command = this.settings.tunnelCommand.trim();
    if (command.length === 0) {
      return;
    }
    this.tunnel = await Tunnel.start(command, this.port);
    console.log(`[editor] tunnel origin ${this.tunnel.origin}`);
  }

  async dispose(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.tunnel?.dispose();
    this.tunnel = null;
    if (this.child.exitCode == null && this.child.signalCode == null) {
      this.signalGroup("SIGTERM");
      const kill = setTimeout(() => this.signalGroup("SIGKILL"), KILL_GRACE_MS);
      kill.unref();
    }
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid == null) {
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      this.child.kill(signal);
    }
  }

  private async waitUntilListening(): Promise<void> {
    const failure = new Promise<never>((_, reject) => {
      this.child.once("error", (error: Error) => reject(error));
      this.child.once("exit", (code) => reject(new Error(`Editor server exited with code ${String(code)}`)));
    });
    failure.catch(() => undefined);

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.stopped) {
        throw new Error("Editor server was stopped while starting");
      }
      // Racing the child's exit turns "binary missing" and "bad flag" into an error now, not a
      // 90-second wait for a port that was never going to open.
      const listening = await Promise.race([
        canConnect(reachableHost(this.settings.bindHost), this.port),
        failure,
      ]);
      if (listening) {
        return;
      }
      await Promise.race([delay(READY_POLL_MS), failure]);
    }
    throw new Error(`Editor server did not start listening within ${String(READY_TIMEOUT_MS)}ms`);
  }
}

/** 0.0.0.0 and :: are bind addresses, not addresses a client can open. */
function reachableHost(bindHost: string): string {
  if (bindHost === "0.0.0.0" || bindHost === "") {
    return "127.0.0.1";
  }
  return bindHost === "::" ? "[::1]" : bindHost;
}

export function splitArgs(value: string): string[] {
  return value.trim().length === 0 ? [] : value.trim().split(/\s+/);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(READY_POLL_MS, () => finish(false));
  });
}

function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, host === "" ? undefined : host, () => {
      const address = probe.address();
      const port = typeof address === "object" && address != null ? address.port : 0;
      probe.close(() => {
        if (port === 0) {
          reject(new Error("Could not reserve a port for the editor server"));
          return;
        }
        resolve(port);
      });
    });
  });
}
