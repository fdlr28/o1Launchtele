import { constants } from 'node:fs';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Address, Hash } from 'viem';
import type { Product } from '../o1/types.js';

export interface HistoryEntry {
  ts: string;
  kind: 'launch' | 'devbuy' | 'approval';
  status: 'sent' | 'confirmed' | 'reverted' | 'unknown' | 'failed';
  chainId: number;
  product?: Product;
  /** The draft this transaction belongs to; a draft is launched at most once. */
  draftId?: string;
  name?: string;
  symbol?: string;
  token?: Address;
  quote?: Address;
  txHash?: Hash;
  note?: string;
}

/**
 * Append-only JSONL log of everything the bot sent on chain. A transaction is logged as "sent" BEFORE it
 * is broadcast, so a crash or a lost reply can never leave a transaction that only the chain knows about.
 *
 * The log is what stops a second launch, so it fails closed: a file that exists but cannot be read is an
 * error, never "no history".
 */
export class History {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'launches.jsonl');
  }

  /**
   * Fails early (at startup, in `npm run doctor`) when the log cannot be written: without a durable record no
   * transaction is ever sent, so a bot that cannot write it could not launch anything anyway.
   */
  async assertWritable(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await access(this.dir, constants.W_OK);
    try {
      await access(this.file, constants.R_OK | constants.W_OK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /** Durable when it returns: written and fsync'ed. */
  async append(entry: Omit<HistoryEntry, 'ts'>): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const line: HistoryEntry = { ts: new Date().toISOString(), ...entry };
    const handle = await open(this.file, 'a', 0o600);
    try {
      // The leading newline keeps this record readable even when a crash left the previous one half written.
      await handle.write(`\n${JSON.stringify(line)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Latest state per transaction (a later line for the same hash overrides an earlier one), oldest first. */
  private async merged(kind: HistoryEntry['kind']): Promise<HistoryEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const byKey = new Map<string, HistoryEntry>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (entry.kind !== kind) continue;
        const key = `${entry.chainId}:${entry.txHash ?? entry.ts}`;
        byKey.set(key, { ...byKey.get(key), ...entry });
      } catch {
        // a torn or corrupt line is skipped rather than losing the whole history
      }
    }
    return [...byKey.values()];
  }

  /** Most recent transactions of a kind, newest first. */
  async recent(kind: HistoryEntry['kind'], limit: number): Promise<HistoryEntry[]> {
    return (await this.merged(kind)).slice(-limit).reverse();
  }

  /** Launch transactions whose outcome is still unknown: sent (or lost) and never confirmed, reverted or dismissed. */
  async pending(): Promise<HistoryEntry[]> {
    return (await this.merged('launch')).filter((e) => e.txHash && (e.status === 'sent' || e.status === 'unknown'));
  }

  /** Every launch transaction recorded for one draft, oldest first. */
  async launchesOfDraft(draftId: string): Promise<HistoryEntry[]> {
    return (await this.merged('launch')).filter((e) => e.draftId === draftId);
  }
}
