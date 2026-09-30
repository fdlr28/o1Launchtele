import { describe, expect, it } from 'vitest';
import { pendingNotice, settledNotice } from '../src/notices.js';
import type { HistoryEntry } from '../src/services/history.js';
import { TOKEN } from './fixtures.js';

const HASH = `0x${'ab'.repeat(32)}` as const;
const entry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  ts: '2026-01-01T00:00:00.000Z', kind: 'launch', status: 'unknown', chainId: 8453, name: 'Pepe <Coin>', symbol: 'PEPE', token: TOKEN, txHash: HASH, ...overrides,
});

describe('pendingNotice', () => {
  it('lists each unresolved launch with its explorer link and tells the owner what blocks and how to release it', () => {
    const text = pendingNotice([entry(), entry({ chainId: 56, txHash: `0x${'cd'.repeat(32)}` })], {});
    expect(text).toContain(`Pepe <Coin> ($PEPE) · Base · https://basescan.org/tx/${HASH}`);
    expect(text).toContain('BSC');
    expect(text).toContain('Launch baru diblokir');
    expect(text).toContain('/dismiss ya');
  });

  it('falls back to the bare hash on a chain without an explorer, and honours an explorer override', () => {
    expect(pendingNotice([entry({ chainId: 5042 })], {})).toContain(HASH);
    expect(pendingNotice([entry({ chainId: 5042 })], { 5042: 'https://arc.example' })).toContain(`https://arc.example/tx/${HASH}`);
  });
});

describe('settledNotice', () => {
  it('a launch that turned out to have confirmed says so, gives the token, and closes the draft', () => {
    const text = settledNotice(entry({ status: 'confirmed' }), 'confirmed', {});
    expect(text).toContain('ternyata BERHASIL');
    expect(text).toContain(`Token: ${TOKEN}`);
    expect(text).toContain(`Tx: https://basescan.org/tx/${HASH}`);
    expect(text).toContain('tidak bisa diluncurkan lagi');
  });

  it('a launch that reverted says nothing was created and that retrying is fine', () => {
    const text = settledNotice(entry(), 'reverted', {});
    expect(text).toContain('ternyata GAGAL');
    expect(text).toContain('Tidak ada token yang dibuat');
    expect(text).not.toContain('Token:');
  });

  it('a launch given up on says why, without blank-line clutter when there is no reason', () => {
    const text = settledNotice(entry({ note: 'not found on chain after 30 minutes' }), 'failed', {});
    expect(text).toContain('dianggap gugur');
    expect(text).toContain('Alasan: not found on chain after 30 minutes.');
    expect(settledNotice(entry(), 'failed', {})).not.toContain('Alasan');
    expect(settledNotice(entry(), 'failed', {})).not.toMatch(/\n\n\n/);
  });
});
