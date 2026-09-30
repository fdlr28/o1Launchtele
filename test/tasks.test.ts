import { describe, expect, it } from 'vitest';
import { BackgroundTasks } from '../src/bot/tasks.js';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('BackgroundTasks', () => {
  it('is idle at once when nothing runs', async () => {
    await expect(new BackgroundTasks().idle(10)).resolves.toBe(true);
  });

  it('waits for tracked tasks, including ones added while waiting', async () => {
    const tasks = new BackgroundTasks();
    const a = deferred();
    const b = deferred();
    tasks.track(a.promise);
    expect(tasks.size).toBe(1);

    const idle = tasks.idle(2_000);
    let done = false;
    void idle.then(() => (done = true));
    a.resolve();
    tasks.track(b.promise); // a follow-up task registered before the first one is noticed as finished
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);

    b.resolve();
    await expect(idle).resolves.toBe(true);
    expect(tasks.size).toBe(0);
  });

  it('gives up after the timeout', async () => {
    const tasks = new BackgroundTasks();
    const never = deferred();
    tasks.track(never.promise);
    await expect(tasks.idle(20)).resolves.toBe(false);
    expect(tasks.size).toBe(1);
    never.resolve();
  });

  it('forgets failed tasks and does not turn them into unhandled rejections', async () => {
    const tasks = new BackgroundTasks();
    const failing = deferred();
    const tracked = tasks.track(failing.promise);
    failing.reject(new Error('boom'));
    await expect(tracked).rejects.toThrow('boom'); // the caller still sees the failure
    await expect(tasks.idle(100)).resolves.toBe(true);
    expect(tasks.size).toBe(0);
  });
});
