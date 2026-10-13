// The reconcile queue: one worker, each Tenant at most once in the queue, and a
// pass over shared state after the queue empties.
//
// Work queued while the worker is busy -- in a reconcile, or in the shared pass
// after it -- must still be done. An earlier version ran the shared pass after
// its loop and then returned, so a spec change arriving during that pass sat in
// the queue until the next resync (seen: a Tenant switched back to Manage
// stayed Observing for two minutes).
export class WorkQueue {
  private readonly queue = new Set<string>();
  private running = false;

  private readonly work: (name: string) => Promise<void>;
  private readonly afterEach: () => Promise<void>;

  constructor(work: (name: string) => Promise<void>, afterEach: () => Promise<void> = async () => {}) {
    this.work = work;
    this.afterEach = afterEach;
  }

  add(...names: string[]): Promise<void> {
    for (const n of names) this.queue.add(n);
    return this.drain();
  }

  get size(): number { return this.queue.size; }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Re-checked after the shared pass: no await lies between the last check
      // and `running = false`, so nothing added meanwhile can be stranded.
      while (this.queue.size) {
        while (this.queue.size) {
          const name = this.queue.values().next().value as string;
          this.queue.delete(name);
          await this.work(name);
        }
        await this.afterEach();
      }
    } finally {
      this.running = false;
    }
  }
}
