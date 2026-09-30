import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { History } from '../src/services/history.js';
import { addr } from './fixtures.js';
import { tempDir } from './fakes.js';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const launch = (overrides: Record<string, unknown> = {}) => ({ kind: 'launch' as const, status: 'sent' as const, chainId: 8453, txHash: hash(1), ...overrides });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('History', () => {
  it('appends JSON lines, creating the data directory (700) and the file (600)', async () => {
    const dir = join(tempDir(), 'nested', 'data');
    const history = new History(dir);
    await history.append(launch({ name: 'Pepe' }));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'launches.jsonl')).mode & 0o777).toBe(0o600);
    const lines = readFileSync(join(dir, 'launches.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines).toEqual([expect.objectContaining({ kind: 'launch', status: 'sent', name: 'Pepe', txHash: hash(1) })]);
    expect(Date.parse(lines[0].ts)).not.toBeNaN();
  });

  it('forces every record to disk before append() returns (the write-ahead must survive a power cut)', async () => {
    const dir = tempDir();
    const probe = await open(join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const sync = vi.spyOn(proto, 'sync');
    await new History(dir).append(launch());
    await new History(dir).append(launch({ status: 'confirmed' }));
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('a record torn by a crash does not swallow the NEXT record (the write-ahead line must not vanish)', async () => {
    const dir = tempDir();
    const history = new History(dir);
    await history.append(launch({ txHash: hash(1) }));
    // the process died in the middle of the next write: half a JSON object, no newline
    appendFileSync(join(dir, 'launches.jsonl'), '{"ts":"2026-01-01T00:00:00.000Z","kind":"launch","status":"sen');
    await history.append(launch({ txHash: hash(2) }));
    expect((await history.pending()).map((e) => e.txHash)).toEqual([hash(1), hash(2)]);
  });

  it('skips corrupt lines instead of losing the whole history', async () => {
    const dir = tempDir();
    const history = new History(dir);
    await history.append(launch({ txHash: hash(1) }));
    appendFileSync(join(dir, 'launches.jsonl'), 'this is not json\n{"broken":\n');
    await history.append(launch({ txHash: hash(2) }));
    expect((await history.pending()).map((e) => e.txHash)).toEqual([hash(1), hash(2)]);
  });

  it('no file yet means no history, but a file that cannot be read is an ERROR (the log is what stops a second launch)', async () => {
    const dir = tempDir();
    const history = new History(dir);
    await expect(history.pending()).resolves.toEqual([]);
    await expect(history.recent('launch', 5)).resolves.toEqual([]);
    await expect(history.launchesOfDraft('d1')).resolves.toEqual([]);

    mkdirSync(join(dir, 'launches.jsonl')); // EISDIR
    await expect(history.pending()).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(history.launchesOfDraft('d1')).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(history.recent('launch', 5)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('a later line for the same transaction overrides the status and keeps what the first line knew', async () => {
    const dir = tempDir();
    const history = new History(dir);
    await history.append(launch({ status: 'sent', name: 'Pepe', symbol: 'PEPE', draftId: 'd1', token: addr(0x77) }));
    await history.append(launch({ status: 'confirmed' }));
    const [entry] = await history.recent('launch', 5);
    expect(entry).toMatchObject({ status: 'confirmed', name: 'Pepe', symbol: 'PEPE', draftId: 'd1', token: addr(0x77) });
    expect(await history.recent('launch', 5)).toHaveLength(1);
  });

  it('the same hash on two chains is two transactions', async () => {
    const history = new History(tempDir());
    await history.append(launch({ chainId: 8453, status: 'sent' }));
    await history.append(launch({ chainId: 56, status: 'sent' }));
    await history.append(launch({ chainId: 8453, status: 'confirmed' }));
    const pending = await history.pending();
    expect(pending.map((e) => e.chainId)).toEqual([56]);
  });

  it('pending() lists launches that are sent or unknown, with a hash, and nothing else', async () => {
    const history = new History(tempDir());
    await history.append(launch({ txHash: hash(1), status: 'sent' }));
    await history.append(launch({ txHash: hash(2), status: 'unknown' }));
    await history.append(launch({ txHash: hash(3), status: 'confirmed' }));
    await history.append(launch({ txHash: hash(4), status: 'reverted' }));
    await history.append(launch({ txHash: hash(5), status: 'failed' }));
    await history.append({ kind: 'launch', status: 'sent', chainId: 8453 }); // no hash: not something to look up
    await history.append({ kind: 'approval', status: 'sent', chainId: 8453, txHash: hash(6) });
    await history.append({ kind: 'devbuy', status: 'unknown', chainId: 8453, txHash: hash(7) });
    expect((await history.pending()).map((e) => e.txHash)).toEqual([hash(1), hash(2)]);
  });

  it('launchesOfDraft() returns every launch line of one draft, oldest first', async () => {
    const history = new History(tempDir());
    await history.append(launch({ txHash: hash(1), draftId: 'a', status: 'failed' }));
    await history.append(launch({ txHash: hash(2), draftId: 'b', status: 'confirmed' }));
    await history.append(launch({ txHash: hash(3), draftId: 'a', status: 'confirmed' }));
    await history.append({ kind: 'devbuy', status: 'confirmed', chainId: 8453, txHash: hash(4), draftId: 'a' });
    expect((await history.launchesOfDraft('a')).map((e) => [e.txHash, e.status])).toEqual([[hash(1), 'failed'], [hash(3), 'confirmed']]);
    expect(await history.launchesOfDraft('zzz')).toEqual([]);
  });

  it('recent() is newest first and limited', async () => {
    const history = new History(tempDir());
    for (const n of [1, 2, 3, 4]) await history.append(launch({ txHash: hash(n), status: 'confirmed' }));
    expect((await history.recent('launch', 2)).map((e) => e.txHash)).toEqual([hash(4), hash(3)]);
  });

  it('writes from two places do not interleave inside a line', async () => {
    const dir = tempDir();
    const history = new History(dir);
    await Promise.all(Array.from({ length: 25 }, (_, i) => history.append(launch({ txHash: hash(i + 1), status: 'confirmed' }))));
    const text = readFileSync(join(dir, 'launches.jsonl'), 'utf8');
    expect(text.split('\n').filter(Boolean).every((line) => JSON.parse(line).kind === 'launch')).toBe(true);
    expect(await new History(dir).recent('launch', 100)).toHaveLength(25);
  });

  it('leaves an existing file alone: append never truncates', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'launches.jsonl'), `${JSON.stringify({ ts: 'x', kind: 'launch', status: 'sent', chainId: 8453, txHash: hash(9) })}\n`);
    await new History(dir).append(launch({ txHash: hash(10) }));
    expect((await new History(dir).pending()).map((e) => e.txHash)).toEqual([hash(9), hash(10)]);
  });
});
