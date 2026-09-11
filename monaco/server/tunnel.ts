import { spawn, type ChildProcess } from "node:child_process";

const URL_TIMEOUT_MS = 60_000;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/;

/**
 * Paseo gives plugins no way to carry a port over its own connection, so reaching a remote daemon
 * without touching the network by hand means running a tunnel of your own. Any program that prints
 * its public URL works: cloudflared, tailscale, ngrok.
 */
export class Tunnel {
  private constructor(
    private readonly child: ChildProcess,
    readonly origin: string,
  ) {}

  static async start(command: string, port: number): Promise<Tunnel> {
    const argv = command.replaceAll("{port}", String(port)).trim().split(/\s+/);
    const [executable, ...args] = argv;
    if (executable == null || executable.length === 0) {
      throw new Error("Tunnel command is empty");
    }

    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    try {
      const origin = await firstUrl(child);
      return new Tunnel(child, origin);
    } catch (error) {
      killGroup(child, "SIGKILL");
      throw error;
    }
  }

  dispose(): void {
    killGroup(this.child, "SIGTERM");
  }
}

function firstUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        run();
      }
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error("The tunnel printed no URL"))),
      URL_TIMEOUT_MS,
    );
    timer.unref();

    const scan = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      console.log(`[tunnel] ${text.trimEnd()}`);
      const match = URL_PATTERN.exec(text);
      if (match != null) {
        finish(() => resolve(match[0].replace(/[.,)]+$/, "")));
      }
    };

    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.once("error", (error: Error) => finish(() => reject(error)));
    child.once("exit", (code) =>
      finish(() => reject(new Error(`The tunnel exited with code ${String(code)}`))),
    );
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid == null) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}
