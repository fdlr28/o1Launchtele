import { chainName, txUrl } from './chains.js';
import type { HistoryEntry } from './services/history.js';

/** Plain-text messages the bot sends on its own initiative (no HTML, so nothing to escape). */

type ExplorerUrls = Record<number, string>;

const describe = (e: HistoryEntry): string => `${e.name ?? '?'} ($${e.symbol ?? '?'}) · ${chainName(e.chainId)}`;
const txLine = (e: HistoryEntry, explorerUrls: ExplorerUrls): string => `Tx: ${(e.txHash ? txUrl(e.chainId, e.txHash, explorerUrls) : null) ?? e.txHash ?? '?'}`;

/** Sent at startup when a launch from before a crash or restart is still unresolved. */
export function pendingNotice(pending: HistoryEntry[], explorerUrls: ExplorerUrls): string {
  return [
    '⚠️ Bot baru saja menyala dan menemukan launch yang hasilnya belum jelas:',
    ...pending.map((e) => `• ${describe(e)} · ${(e.txHash ? txUrl(e.chainId, e.txHash, explorerUrls) : null) ?? e.txHash ?? '?'}`),
    '',
    'Launch baru diblokir sampai ini jelas, supaya tidak terjadi dobel. Periksa transaksinya di explorer; bot juga akan memberi tahu begitu hasilnya terlihat.',
    'Kalau kamu yakin tidak akan terkonfirmasi, kirim /dismiss ya.',
  ].join('\n');
}

/** Sent when a launch that had been reported as unclear turns out to have confirmed, reverted or vanished. */
export function settledNotice(entry: HistoryEntry, status: 'confirmed' | 'reverted' | 'failed', explorerUrls: ExplorerUrls): string {
  if (status === 'confirmed') {
    return [
      `✅ Launch yang tadinya belum jelas ternyata BERHASIL: ${describe(entry)}`,
      ...(entry.token ? [`Token: ${entry.token}`] : []),
      txLine(entry, explorerUrls),
      '',
      'Draf itu sudah selesai dan tidak bisa diluncurkan lagi. Untuk launch berikutnya, buka /launch.',
    ].join('\n');
  }
  if (status === 'reverted') {
    return [
      `❌ Launch yang tadinya belum jelas ternyata GAGAL (revert di chain): ${describe(entry)}`,
      txLine(entry, explorerUrls),
      '',
      'Tidak ada token yang dibuat. Kamu boleh mencoba lagi lewat /launch.',
    ].join('\n');
  }
  return [
    `ℹ️ Launch yang belum jelas dianggap gugur: ${describe(entry)}`,
    txLine(entry, explorerUrls),
    entry.note ? `Alasan: ${entry.note}.` : '',
    '',
    'Transaksinya tidak pernah terlihat di chain dan wallet tidak punya transaksi tertunda. Kamu boleh mencoba lagi lewat /launch.',
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n');
}
