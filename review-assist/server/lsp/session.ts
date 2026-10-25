import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { z } from "zod";
import { decodeMessages, encodeMessage } from "./framing";

const REQUEST_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

const jsonRpcMessageSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const configurationParamsSchema = z.object({ items: z.array(z.unknown()) });

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class LspSession {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly documents = new Map<string, { version: number; text: string }>();
  private received: Buffer[] = [];
  private receivedBytes = 0;
  private neededBytes = 0;
  private nextId = 1;
  private stopped = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly rootPath: string,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => console.error(`[lsp] ${chunk.toString("utf8").trimEnd()}`));
    // A write racing the server's death emits EPIPE on stdin; unhandled, it takes down the whole
    // plugin subprocess and every other repository's servers with it.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on("error", (error: Error) => this.fail(error));
    }
    child.on("error", (error: Error) => this.fail(error));
    child.on("exit", (code) => this.fail(new Error(`Language server exited with code ${String(code)}`)));
  }

  static async start(argv: readonly string[], rootPath: string): Promise<LspSession> {
    const [command, ...args] = argv;
    if (command == null) {
      throw new Error("Language server command is empty");
    }
    const child = spawnProcess(command, args, { cwd: rootPath, stdio: "pipe" });
    const session = new LspSession(child, rootPath);
    try {
      await session.initialize();
    } catch (error) {
      // A server that spawned but never answered initialize is untracked; nothing else can stop it.
      await terminateProcess(child);
      throw error;
    }
    return session;
  }

  get running(): boolean {
    return !this.stopped;
  }

  async request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.stopped) {
      throw new Error("Language server is not running");
    }
    const id = this.nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  sync(uri: string, languageId: string, text: string): void {
    const open = this.documents.get(uri);
    if (open == null) {
      this.documents.set(uri, { version: 1, text });
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
      return;
    }
    if (open.text === text) {
      return;
    }
    const version = open.version + 1;
    this.documents.set(uri, { version, text });
    this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
  }

  /** Terminates the process even after a stream error stopped the session with the process alive. */
  async dispose(): Promise<void> {
    if (!this.stopped) {
      try {
        await this.request("shutdown", null, SHUTDOWN_TIMEOUT_MS);
        this.notify("exit", undefined);
      } catch {}
      this.fail(new Error("Language server stopped"));
    }
    await terminateProcess(this.child);
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "paseo-review-assist" },
      rootUri: this.rootUri(),
      rootPath: this.rootPath,
      workspaceFolders: [this.workspaceFolder()],
      capabilities: {
        workspace: { workspaceFolders: true, configuration: true },
        textDocument: {
          synchronization: {},
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
        },
        window: { workDoneProgress: true },
      },
    });
    this.notify("initialized", {});
  }

  private rootUri(): string {
    return pathToFileURL(this.rootPath).href;
  }

  private workspaceFolder(): { uri: string; name: string } {
    return { uri: this.rootUri(), name: basename(this.rootPath) };
  }

  private send(message: object): void {
    if (this.stopped || this.child.stdin.destroyed) {
      return;
    }
    this.child.stdin.write(encodeMessage(message));
  }

  private receive(chunk: Buffer): void {
    this.received.push(chunk);
    this.receivedBytes += chunk.byteLength;
    if (this.receivedBytes < this.neededBytes) {
      return;
    }
    const { bodies, rest, needed } = decodeMessages(Buffer.concat(this.received, this.receivedBytes));
    this.received = [rest];
    this.receivedBytes = rest.byteLength;
    this.neededBytes = needed;
    for (const body of bodies) {
      this.dispatch(body);
    }
  }

  private dispatch(body: string): void {
    let json: unknown = null;
    try {
      json = JSON.parse(body);
    } catch {}
    const parsed = jsonRpcMessageSchema.safeParse(json);
    if (!parsed.success) {
      console.error("[lsp] dropped an unparseable message");
      return;
    }
    const message = parsed.data;

    if (message.method != null) {
      if (message.id != null) {
        this.answer(message.id, message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending == null) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error != null) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  private answer(id: number | string, method: string, params: unknown): void {
    if (method === "workspace/workspaceFolders") {
      this.send({ jsonrpc: "2.0", id, result: [this.workspaceFolder()] });
      return;
    }
    if (method === "workspace/configuration") {
      const configuration = configurationParamsSchema.safeParse(params);
      const items = configuration.success ? configuration.data.items : [];
      this.send({ jsonrpc: "2.0", id, result: items.map(() => null) });
      return;
    }
    this.send({ jsonrpc: "2.0", id, result: null });
  }

  private fail(error: Error): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.documents.clear();
  }
}
