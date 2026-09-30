import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Address, Hash } from 'viem';
import type { Product } from '../o1/types.js';

export interface HistoryEntry {
  ts: string;
  kind: 'launch' | 'devbuy' | 'approval';
  status: 'sent' | 'confirmed' | 'reverted' | 'unknown' | 'failed';
  chainId: number;
  product?: Product;
  name?: string;
  symbol?: string;
  token?: Address;
  quote?: Address;
  txHash?: Hash;
  note?: string;
}

/** Append-only JSONL log of everything the bot sent on chain (written before waiting for receipts). */
export class History {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'launches.jsonl');
  }

  async append(entry: Omit<HistoryEntry, 'ts'>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const line: HistoryEntry = { ts: new Date().toISOString(), ...entry };
    await appendFile(this.file, JSON.stringify(line) + '\n', { mode: 0o600 });
  }

  /** Latest state per transaction (a later line for the same hash overrides an earlier one). */
  async recent(kind: HistoryEntry['kind'], limit: number): Promise<HistoryEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    const byKey = new Map<string, HistoryEntry>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (entry.kind !== kind) continue;
        byKey.set(`${entry.chainId}:${entry.txHash ?? entry.ts}`, { ...byKey.get(`${entry.chainId}:${entry.txHash ?? entry.ts}`), ...entry });
      } catch {
        // ignore a corrupt line rather than losing the whole history
      }
    }
    return [...byKey.values()].slice(-limit).reverse();
  }
}
