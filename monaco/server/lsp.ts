import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { basename } from "node:path";
import { decodeMessages, encodeMessage } from "./framing";

const REQUEST_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const KILL_GRACE_MS = 2_000;

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class LspSession {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly documentVersions = new Map<string, number>();
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private stopped = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly rootPath: string,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => console.error(`[lsp] ${chunk.toString("utf8").trimEnd()}`));
    // A write racing the server's death emits EPIPE on stdin; unhandled, it takes down the whole
    // plugin subprocess and every other workspace's sessions with it.
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
    const child = spawn(command, args, { cwd: rootPath, stdio: ["pipe", "pipe", "pipe"] });
    const session = new LspSession(child, rootPath);
    try {
      await session.initialize();
    } catch (error) {
      // A server that spawned but never answered initialize is untracked; nothing else can kill it.
      child.kill("SIGKILL");
      throw error;
    }
    return session;
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

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  isOpen(uri: string): boolean {
    return this.documentVersions.has(uri);
  }

  openDocument(uri: string, languageId: string, text: string): void {
    this.documentVersions.set(uri, 1);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  changeDocument(uri: string, text: string): void {
    const version = (this.documentVersions.get(uri) ?? 0) + 1;
    this.documentVersions.set(uri, version);
    // ponytail: whole-document replacement even when the server advertises incremental sync.
    // Every server built on vscode-languageserver-node accepts it; switch to real diffs if one does not.
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  saveDocument(uri: string, text: string): void {
    this.notify("textDocument/didSave", { textDocument: { uri }, text });
  }

  closeDocument(uri: string): void {
    if (!this.documentVersions.delete(uri)) {
      return;
    }
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async dispose(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.request("shutdown", null, SHUTDOWN_TIMEOUT_MS);
      this.notify("exit", undefined);
    } catch {
      // A server that will not shut down cleanly still gets killed below.
    }
    this.fail(new Error("Language server stopped"));
    this.child.kill("SIGTERM");
    const kill = setTimeout(() => this.child.kill("SIGKILL"), KILL_GRACE_MS);
    kill.unref();
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "paseo-monaco" },
      rootUri: this.rootUri(),
      rootPath: this.rootPath,
      workspaceFolders: [this.workspaceFolder()],
      capabilities: {
        workspace: { workspaceFolders: true, configuration: true },
        textDocument: {
          synchronization: { didSave: true },
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          completion: {
            completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"] },
          },
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
    const { bodies, rest } = decodeMessages(Buffer.concat([this.buffer, chunk]));
    this.buffer = rest;
    for (const body of bodies) {
      this.dispatch(body);
    }
  }

  private dispatch(body: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(body) as JsonRpcMessage;
    } catch {
      console.error("[lsp] dropped an unparseable message");
      return;
    }

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
      const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
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
    this.documentVersions.clear();
  }
}
