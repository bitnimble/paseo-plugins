import { Worker } from "node:worker_threads";
import type { MermaidOutcome } from "../../shared/protocol";
import type { MermaidRequest, MermaidResponse } from "./messages";
import script from "./worker.js.txt";

const IDLE_MS = 120_000;
const TIMEOUT_MS = 30_000;

/** Draws in a worker thread, whose DOM shim would otherwise replace the daemon's globals. */
export class MermaidRenderer {
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, (outcome: MermaidOutcome) => void>();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  draw(input: Omit<MermaidRequest, "id">): Promise<MermaidOutcome> {
    const worker = this.start();
    const id = this.nextId++;
    clearTimeout(this.idle);
    if (this.pending.size === 0) this.watch();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage({ ...input, id } satisfies MermaidRequest);
    });
  }

  dispose(): void {
    this.stop("The review plugin stopped.");
  }

  private start(): Worker {
    if (this.worker != null) return this.worker;
    const worker = new Worker(script, { eval: true });
    worker.on("message", ({ id, outcome }: MermaidResponse) => this.settle(id, outcome));
    worker.on("error", (error) => {
      if (this.worker === worker) this.stop(`The diagram renderer crashed: ${error.message}`);
    });
    worker.on("exit", () => {
      if (this.worker === worker) this.stop("The diagram renderer exited.");
    });
    this.worker = worker;
    return worker;
  }

  private settle(id: number, outcome: MermaidOutcome): void {
    this.pending.get(id)?.(outcome);
    this.pending.delete(id);
    clearTimeout(this.watchdog);
    if (this.pending.size > 0) {
      this.watch();
      return;
    }
    this.idle = setTimeout(() => this.stop("idle"), IDLE_MS);
    this.idle.unref();
  }

  /** The worker draws one at a time, so only a wait with no drawing finished counts as stuck. */
  private watch(): void {
    this.watchdog = setTimeout(() => this.stop("The diagram took too long to draw."), TIMEOUT_MS);
  }

  private stop(reason: string): void {
    clearTimeout(this.idle);
    clearTimeout(this.watchdog);
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const resolve of waiting) resolve({ status: "unavailable", reason });
  }
}
