/**
 * Work that keeps running after the update handler that started it has returned (a launch takes tens of
 * seconds). Shutdown waits for it, so the last Telegram message of a launch is not lost.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<unknown>>();

  track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    const forget = () => void this.pending.delete(task);
    task.then(forget, forget);
    return task;
  }

  get size(): number {
    return this.pending.size;
  }

  /** True once every tracked task has finished (also those added while waiting), false when `timeoutMs` ran out first. */
  async idle(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    try {
      while (this.pending.size > 0) {
        const outcome = await Promise.race([Promise.allSettled([...this.pending]).then(() => true as const), timedOut]);
        if (outcome === false) return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }
}
