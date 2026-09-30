import type { Address } from 'viem';
import { antiSnipeWindowSeconds } from '../domain/devbuy.js';
import type { Draft } from '../domain/draft.js';
import { describeTax, type TaxPolicy } from '../domain/tax.js';
import { formatAmount, formatPercent } from '../domain/units.js';
import type { PairFilter } from '../o1/catalog.js';
import type { ContractSuite } from '../o1/types.js';
import type { LaunchOutcome, ProgressEvent, Stage } from '../services/launcher.js';
import type { Review } from '../services/review.js';
import { bytesLabel, code, esc, link, shortAddress } from './format.js';
import type { FieldKey } from './state.js';

export type Explorer = (kind: 'tx' | 'address', value: string) => string | null;

const CONTENT_LIMIT = 3900; // Telegram's hard limit is 4096

function clip(text: string, max = CONTENT_LIMIT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function shorten(value: string, max = 42): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const empty = '<i>belum diisi</i>';
const productLabel = (draft: Draft) => (draft.product === 'tax' ? 'Tax (buy/sell tax kustom)' : 'Standard (fee swap standar o1)');

export function pairLabel(quote: { symbol: string; route: string }): string {
  return quote.route === 'rwa' ? `${quote.symbol} (stock)` : quote.symbol;
}

export function devBuyLabel(draft: Draft, quoteSymbol: string | undefined, decimals: number): string {
  const dev = draft.devBuy;
  if (!dev.enabled) return 'OFF';
  const amount = dev.amountRaw ? esc(`${formatAmount(BigInt(dev.amountRaw), decimals)} ${quoteSymbol ?? ''}`.trim()) : '<i>jumlah belum diisi</i>';
  const timing = dev.timing === 'auto' ? 'tunggu anti-snipe' : 'segera';
  return `ON · ${amount} · slippage ${formatPercent(BigInt(dev.slippageBps) * 10_000n)}% · ${timing}`;
}

// ---------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------

export interface DashboardData {
  draft: Draft;
  wallet: Address;
  chainName: string;
  policy: TaxPolicy | null;
  notice: string | null;
}

export function dashboardText({ draft, wallet, chainName, policy, notice }: DashboardData): string {
  const lines: string[] = ['🚀 <b>Draft Launch o1</b>', ''];
  if (notice) lines.push(`⚠️ ${esc(notice)}`, '');

  lines.push(`⛓ Chain: <b>${esc(chainName)}</b>`);
  lines.push(`🧾 Tipe: <b>${esc(productLabel(draft))}</b>`);
  lines.push(`💱 Pair: ${draft.quote ? `<b>${esc(pairLabel(draft.quote))}</b>` : empty}`);
  lines.push('');
  lines.push(`🏷 Nama: ${draft.name ? `<b>${esc(draft.name)}</b>` : empty}`);
  lines.push(`🔤 Simbol: ${draft.symbol ? `<b>${esc(draft.symbol)}</b>` : empty}`);
  lines.push(`🖼 Gambar: ${draft.image ? `${draft.image.type.replace('image/', '').toUpperCase()} · ${bytesLabel(draft.image.bytes)}` : empty}`);
  lines.push(`📝 Deskripsi: ${draft.description ? esc(shorten(draft.description.replace(/\s+/g, ' '), 60)) : '—'}`);
  lines.push(`🌐 Website: ${draft.website ? esc(shorten(draft.website)) : '—'}`);
  lines.push(`𝕏 X: ${draft.x ? esc(shorten(draft.x)) : '—'}`);
  lines.push(`✈️ Telegram: ${draft.telegram ? esc(shorten(draft.telegram)) : '—'}`);

  if (draft.product === 'tax') {
    lines.push('', '💸 <b>Tax</b>');
    for (const line of describeTax(draft.tax, policy)) lines.push(`  ${esc(line)}`);
    lines.push(`  Penerima creator fee: ${code(shortAddress(draft.tax.creatorRecipient))}`);
  }
  lines.push('', `💰 Dev Buy: ${devBuyLabel(draft, draft.quote?.symbol, draft.quote?.decimals ?? 18)}`);
  lines.push(`🖊 Profil bisa diedit setelah launch: ${draft.editableMetadata ? 'ya' : 'tidak'}`);
  lines.push('', `👛 Wallet: ${code(shortAddress(wallet))}`);
  return clip(lines.join('\n'));
}

// ---------------------------------------------------------------------------------------------
// Sub views
// ---------------------------------------------------------------------------------------------

export function chainViewText(): string {
  return '⛓ <b>Pilih chain</b>\nPair dan pengaturan tax akan disesuaikan dengan chain yang dipilih.';
}

export function taxViewText(draft: Draft, policy: TaxPolicy | null, chainName: string): string {
  const lines = [`💸 <b>Pengaturan Tax</b> — ${esc(chainName)}`, ''];
  if (policy) {
    lines.push(
      `Batas kebijakan: buy ${formatPercent(policy.minBuy)}–${formatPercent(policy.maxBuy)}% · sell ${formatPercent(policy.minSell)}–${formatPercent(policy.maxSell)}%`,
      `Protocol o1 mengambil ${formatPercent(policy.protocolShare)}% dari tax (min ${formatPercent(policy.protocolMin)}%, maks ${formatPercent(policy.protocolMax)}% dari nilai trade).`,
      '',
    );
  } else {
    lines.push('<i>Kebijakan tax chain ini belum bisa dimuat; validasi lengkap dilakukan saat Review.</i>', '');
  }
  for (const line of describeTax(draft.tax, policy)) lines.push(esc(line));
  lines.push(`Penerima creator fee: ${code(draft.tax.creatorRecipient)}`);
  lines.push('', '<i>Tax dihitung dari nilai trade di pool launch dan sudah termasuk bagian protocol. Angka tax dan pembagian tidak bisa diubah setelah launch.</i>');
  return clip(lines.join('\n'));
}

export function devViewText(draft: Draft, suite: ContractSuite | undefined): string {
  const quote = draft.quote;
  const window = suite ? antiSnipeWindowSeconds(draft, suite) : 20;
  const lines = [
    '💰 <b>Dev Buy</b>',
    '',
    `Status: <b>${draft.devBuy.enabled ? 'ON' : 'OFF'}</b>`,
    `Jumlah: ${draft.devBuy.amountRaw && quote ? `<b>${esc(formatAmount(BigInt(draft.devBuy.amountRaw), quote.decimals))} ${esc(quote.symbol)}</b>` : empty}`,
    `Slippage: <b>${formatPercent(BigInt(draft.devBuy.slippageBps) * 10_000n)}%</b>`,
    `Waktu beli: <b>${draft.devBuy.timing === 'auto' ? `tunggu anti-snipe selesai${window > 0 ? ` (~${window} dtk)` : ''}` : 'segera setelah token terindeks'}</b>`,
    '',
    'ℹ️ Dev buy dijalankan <b>setelah</b> launch terkonfirmasi, sebagai swap biasa lewat API o1. Ini <b>bukan atomic</b>: API publik o1 belum menyediakan atomic dev buy, jadi sniper bisa membeli lebih dulu.',
    '• <b>Tunggu anti-snipe</b>: bot menunggu surcharge pembukaan (mulai 99%) turun ke fee normal sebelum membeli.',
    '• <b>Segera</b>: membeli secepat mungkin, tetapi bisa kena surcharge besar.',
    '• Dev buy tetap membayar fee/tax beli normal.',
    '• FDV pembukaan token sekitar US$4.000, jadi dev buy kecil pun bisa mengambil porsi supply yang besar.',
  ];
  return clip(lines.join('\n'));
}

export interface PairViewData {
  chainName: string;
  productLabel: string;
  filter: PairFilter;
  query: string;
  page: number;
  pages: number;
  total: number;
  hasStocks: boolean;
  current: string | null;
}

export function pairViewText(d: PairViewData): string {
  const lines = [
    `💱 <b>Pilih pair (quote token)</b> — ${esc(d.chainName)} · ${esc(d.productLabel)}`,
    '',
    `Daftar: <b>${d.filter === 'crypto' ? 'Crypto' : 'Stocks'}</b> · ${d.total} tersedia${d.query ? ` · cari: <code>${esc(d.query)}</code>` : ''}`,
    d.pages > 1 ? `Halaman ${d.page + 1}/${d.pages}` : '',
    d.current ? `Terpilih: <b>${esc(d.current)}</b>` : '',
    '',
    'Pair menentukan aset lawan di pool dan mata uang untuk fee, dividen, serta dev buy.',
  ];
  if (d.total === 0) lines.push('', '<i>Tidak ada pair yang cocok.</i>');
  return lines.filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n');
}

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

export interface PromptEnv {
  policy: TaxPolicy | null;
  quoteSymbol?: string;
  holdingFloorText: string;
}

const PROMPTS: Record<FieldKey, (env: PromptEnv) => string> = {
  name: () => '🏷 Kirim <b>nama token</b> (maks 50 karakter).',
  symbol: () => '🔤 Kirim <b>simbol</b> token (maks 11 karakter, tanpa spasi). Contoh: <code>PEPE</code>',
  image: () =>
    '🖼 Kirim <b>gambar token</b> sebagai foto atau file (PNG, JPG, WEBP, atau GIF, maks 2 MB). Disarankan persegi, mis. 512×512.\n\nUntuk GIF/WEBP kirim sebagai <i>file/dokumen</i> supaya tidak dikonversi Telegram.',
  description: () => '📝 Kirim <b>deskripsi</b> token (maks 2000 byte). Kirim <code>-</code> untuk mengosongkan.',
  website: () => '🌐 Kirim link <b>website</b>, mis. <code>https://contoh.com</code>. Kirim <code>-</code> untuk menghapus.',
  x: () => '𝕏 Kirim <b>@username</b> atau link akun/komunitas X. Kirim <code>-</code> untuk menghapus.',
  telegram: () => '✈️ Kirim <b>@username</b> atau link Telegram (t.me). Kirim <code>-</code> untuk menghapus.',
  buyTax: ({ policy }) =>
    `💸 Kirim <b>buy tax</b> dalam persen${policy ? ` (batas ${formatPercent(policy.minBuy)}–${formatPercent(policy.maxBuy)}%)` : ''}. Contoh: <code>3</code> atau <code>2.5</code>`,
  sellTax: ({ policy }) =>
    `💸 Kirim <b>sell tax</b> dalam persen${policy ? ` (batas ${formatPercent(policy.minSell)}–${formatPercent(policy.maxSell)}%)` : ''}. Contoh: <code>3</code> atau <code>2.5</code>`,
  split: () =>
    '🧮 Kirim pembagian sisa tax (setelah bagian protocol): <b>creator/dividen/burn</b>, total harus 100.\nContoh: <code>60/40/0</code>',
  minHolding: ({ holdingFloorText }) =>
    `🪙 Kirim <b>minimal token</b> yang harus dipegang holder agar dapat dividen (minimal ${esc(holdingFloorText)}). Contoh: <code>10000</code>, <code>50k</code>, <code>1m</code>`,
  recipient: () =>
    '📥 Kirim <b>alamat wallet penerima creator fee</b> (0x…). Disarankan wallet pribadimu, bukan wallet bot.',
  devAmount: ({ quoteSymbol }) => `💰 Kirim jumlah <b>dev buy</b> dalam ${esc(quoteSymbol ?? 'pair')}. Contoh: <code>0.05</code>`,
  devSlippage: () => '🎚 Kirim <b>slippage</b> dev buy dalam persen (0.01–49.99). Contoh: <code>5</code>',
  pairSearch: () => '🔎 Kirim simbol atau nama pair yang dicari. Contoh: <code>AAPL</code>',
};

export function promptText(field: FieldKey, env: PromptEnv, error?: string): string {
  const base = PROMPTS[field](env);
  return error ? `❌ ${esc(error)}\n\n${base}` : base;
}

// ---------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------

export function reviewText(draft: Draft, review: Review, chainName: string, wallet: Address): string {
  const ctx = review.ctx;
  const lines = ['🔎 <b>Review Launch</b>', ''];

  lines.push(`⛓ ${esc(chainName)} · ${draft.product === 'tax' ? 'Tax' : 'Standard'} · pair <b>${draft.quote ? esc(pairLabel(draft.quote)) : '—'}</b>`);
  lines.push(`🏷 <b>${esc(draft.name ?? '—')}</b> ($${esc(draft.symbol ?? '—')})`);
  if (draft.description) lines.push(`📝 ${esc(shorten(draft.description.replace(/\s+/g, ' '), 140))}`);
  const socials = [draft.website && `🌐 ${esc(shorten(draft.website))}`, draft.x && `𝕏 ${esc(shorten(draft.x))}`, draft.telegram && `✈️ ${esc(shorten(draft.telegram))}`].filter(Boolean);
  if (socials.length) lines.push(socials.join('\n'));
  lines.push(`🖼 ${draft.image ? `${draft.image.type.replace('image/', '').toUpperCase()} · ${bytesLabel(draft.image.bytes)}` : '—'}`);

  if (draft.product === 'tax') {
    lines.push('', '💸 <b>Tax</b> (tetap, tidak bisa diubah setelah launch)');
    for (const line of describeTax(draft.tax, review.taxPolicy)) lines.push(`  ${esc(line)}`);
    lines.push(`  Penerima creator fee: ${code(draft.tax.creatorRecipient)}`);
  } else {
    lines.push('', '💸 Fee swap standar o1; bagian creator terkumpul untuk wallet launcher.');
  }

  lines.push('', '💰 <b>Biaya &amp; dana</b>');
  if (ctx?.fee) {
    lines.push(`  Creation fee: ${esc(formatAmount(ctx.fee.amountRaw, ctx.fee.decimals))} ${esc(ctx.fee.symbol)}`);
  } else if (ctx) {
    lines.push('  Creation fee: tidak ada');
  }
  if (draft.devBuy.enabled) {
    lines.push(`  Dev buy: ${devBuyLabel(draft, draft.quote?.symbol, draft.quote?.decimals ?? 18)}`);
  }
  for (const fund of review.funds) {
    if (fund.balanceRaw === null) continue;
    const need = fund.requiredRaw > 0n ? `butuh ${formatAmount(fund.requiredRaw, fund.decimals)}${fund.isNative ? ' + gas' : ''}` : fund.isNative ? 'butuh gas' : 'tidak dipakai';
    lines.push(`  Saldo ${esc(fund.symbol)}: ${esc(formatAmount(fund.balanceRaw, fund.decimals))} (${esc(need)})`);
  }
  lines.push(`  Wallet: ${code(shortAddress(wallet))}`);

  lines.push('', '🔒 Supply tetap 1 miliar token; likuiditas dikunci permanen oleh kontrak o1.');

  if (review.warnings.length) lines.push('', ...review.warnings.map((w) => `⚠️ ${esc(w)}`));
  if (review.problems.length) {
    lines.push('', '🚫 <b>Belum bisa launch:</b>', ...review.problems.map((p) => `• ${esc(p)}`));
  } else {
    lines.push('', '✅ Semua cek lolos. Tekan tombol di bawah untuk mengirim transaksi launch.');
  }
  return clip(lines.join('\n'));
}

// ---------------------------------------------------------------------------------------------
// Progress and results
// ---------------------------------------------------------------------------------------------

const STAGE_LABEL: Record<Stage, (detail?: string) => string> = {
  checking: () => '🔎 Memeriksa konfigurasi terbaru…',
  preparing: (d) => `🧪 Menyiapkan launch (upload IPFS, mencari alamat berakhiran 01)…${d ? ` (${esc(d)})` : ''}`,
  approving: () => '✍️ Mengirim approval…',
  sending: () => '📤 Menandatangani &amp; mengirim transaksi launch…',
  confirming: () => '⏳ Menunggu konfirmasi block…',
  verifying: () => '🔍 Memverifikasi token di chain…',
  'devbuy-indexing': () => '💰 Dev buy: menunggu token terindeks di API o1…',
  'devbuy-waiting': (d) => `💰 Dev buy: menunggu anti-snipe selesai (~${esc(d ?? '?')} dtk)…`,
  'devbuy-quoting': (d) => `💰 Dev buy: mengambil quote…${d ? ` (${esc(d)})` : ''}`,
  'devbuy-approving': () => '💰 Dev buy: mengirim approval…',
  'devbuy-sending': () => '💰 Dev buy: mengirim swap…',
};

export function progressText(events: ProgressEvent[], explorer: Explorer): string {
  const lines = ['⏳ <b>Sedang launch…</b>', '<i>Jangan tutup bot; ini bisa memakan waktu beberapa detik.</i>', ''];
  // Collapse repeated "confirming" events and mark all but the last as done.
  const shown: ProgressEvent[] = [];
  for (const event of events) {
    const last = shown[shown.length - 1];
    if (last && last.stage === event.stage && event.stage !== 'confirming') shown[shown.length - 1] = event;
    else shown.push(event);
  }
  const tail = shown.slice(-8);
  tail.forEach((event, index) => {
    const label = STAGE_LABEL[event.stage](event.detail);
    const hash = event.txHash ? ` ${link('tx', explorer('tx', event.txHash))} ${code(shortAddress(event.txHash))}` : '';
    lines.push(`${index === tail.length - 1 ? '' : '✅ '}${label}${hash}`);
  });
  return clip(lines.join('\n'));
}

export function resultText(draft: Draft, outcome: LaunchOutcome, chainName: string, explorer: Explorer): string {
  const lines = ['✅ <b>Launch berhasil!</b>', ''];
  lines.push(`<b>${esc(draft.name ?? '')}</b> ($${esc(draft.symbol ?? '')})`);
  lines.push(`Token: ${code(outcome.token)}`);
  lines.push(`Chain: ${esc(chainName)} · Pair: ${draft.quote ? esc(pairLabel(draft.quote)) : '—'} · ${draft.product === 'tax' ? `Tax ${formatPercent(BigInt(draft.tax.buyRate))}%/${formatPercent(BigInt(draft.tax.sellRate))}%` : 'Standard'}`);
  lines.push(`Tx launch: ${link(shortAddress(outcome.launchTx), explorer('tx', outcome.launchTx))}`);
  const tokenLink = explorer('address', outcome.token);
  if (tokenLink) lines.push(link('Lihat token di explorer', tokenLink));
  if (!outcome.codeVerified) {
    lines.push('', '⚠️ Transaksi sukses, tetapi kode kontrak di alamat prediksi belum terbaca (mungkin RPC lambat). Cek manual di explorer.');
  }

  if (draft.devBuy.enabled && outcome.devBuy) {
    lines.push('');
    if (outcome.devBuy.status === 'done') {
      const amount = draft.devBuy.amountRaw && draft.quote ? `${formatAmount(BigInt(draft.devBuy.amountRaw), draft.quote.decimals)} ${draft.quote.symbol}` : '';
      lines.push(`💰 Dev buy: ✅ ${esc(amount)} — ${link(shortAddress(outcome.devBuy.txHash), explorer('tx', outcome.devBuy.txHash))}`);
    } else {
      lines.push(`💰 Dev buy: ⚠️ gagal — ${esc(outcome.devBuy.reason)}`);
      if (outcome.devBuy.txHash) lines.push(`Tx: ${link(shortAddress(outcome.devBuy.txHash), explorer('tx', outcome.devBuy.txHash))}`);
      lines.push('<i>Launch-nya sendiri sudah sukses. Kamu bisa beli manual di launch.o1.exchange.</i>');
    }
  }
  if (draft.product !== 'tax') {
    lines.push('', '<i>Catatan: creator fee tipe Standard terkumpul untuk wallet bot; klaim lewat Profile › Fees di launch.o1.exchange.</i>');
  }
  return clip(lines.join('\n'));
}

export function failureText(message: string, txHash: string | undefined, explorer: Explorer): string {
  const lines = ['❌ <b>Launch gagal</b>', '', esc(message)];
  if (txHash) lines.push('', `Tx: ${link(shortAddress(txHash), explorer('tx', txHash))} ${code(txHash)}`);
  lines.push('', '<i>Draft-mu masih tersimpan. Perbaiki lalu Review ulang.</i>');
  return clip(lines.join('\n'));
}
