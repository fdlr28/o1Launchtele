import { InlineKeyboard } from 'grammy';
import { CHAINS } from '../chains.js';
import type { Draft } from '../domain/draft.js';
import type { TaxPolicy } from '../domain/tax.js';
import { SPLIT_PRESETS } from '../domain/tax.js';
import { ONE_PERCENT, formatPercent, formatTokenAmount } from '../domain/units.js';
import type { QuoteConfiguration } from '../o1/types.js';
import { CLEARABLE_FIELDS } from './fields.js';
import type { FieldKey, PairUi, ViewName } from './state.js';
import { pairLabel } from './texts.js';

const mark = (done: boolean) => (done ? ' ✅' : '');

export const PAIR_PAGE_SIZE = 8;
export const TAX_PRESETS = [1, 3, 5, 10];
export const SLIPPAGE_PRESETS_BPS = [300, 500, 1000, 2500];
/** Whole-token holding presets; entries below the policy floor are hidden. */
export const HOLDING_PRESETS = [10_000n, 100_000n, 1_000_000n];

export function dashboardKeyboard(draft: Draft, chainName: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(`⛓ ${chainName}`, 'nav:chain')
    .text(`🧾 ${draft.product === 'tax' ? 'Tax' : 'Standard'} ⇄`, 'prod:toggle')
    .row()
    .text(`💱 Pair: ${draft.quote ? pairLabel(draft.quote) : 'pilih'}`, 'nav:pair')
    .row()
    .text(`🏷 Nama${mark(!!draft.name)}`, 'in:name:dash')
    .text(`🔤 Simbol${mark(!!draft.symbol)}`, 'in:symbol:dash')
    .row()
    .text(`🖼 Gambar${mark(!!draft.image)}`, 'in:image:dash')
    .text(`📝 Deskripsi${mark(!!draft.description)}`, 'in:description:dash')
    .row()
    .text(`🌐 Website${mark(!!draft.website)}`, 'in:website:dash')
    .text(`𝕏 X${mark(!!draft.x)}`, 'in:x:dash')
    .text(`✈️ Telegram${mark(!!draft.telegram)}`, 'in:telegram:dash')
    .row();
  if (draft.product === 'tax') kb.text('💸 Tax', 'nav:tax');
  kb.text(`💰 Dev Buy: ${draft.devBuy.enabled ? 'ON' : 'OFF'}`, 'nav:dev')
    .row()
    .text(`🖊 Profil bisa diedit: ${draft.editableMetadata ? 'ya' : 'tidak'}`, 'tog:edit')
    .row()
    .text('🔎 Review & Launch', 'nav:review')
    .row()
    .text('🗑 Reset draft', 'go:reset');
  return kb;
}

export function chainKeyboard(chainIds: number[], current: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  chainIds.forEach((id, index) => {
    kb.text(`${id === current ? '✅ ' : ''}${CHAINS[id]?.name ?? id}`, `chain:${id}`);
    if (index % 2 === 1) kb.row();
  });
  return kb.row().text('⬅ Kembali', 'nav:dash');
}

export function taxKeyboard(draft: Draft, policy: TaxPolicy | null): InlineKeyboard {
  const kb = new InlineKeyboard().text('Buy tax', 'in:buyTax:tax').text('Sell tax', 'in:sellTax:tax').row();

  const presets = TAX_PRESETS.filter((p) => {
    const units = BigInt(p) * ONE_PERCENT;
    return !policy || (units >= policy.minBuy && units <= policy.maxBuy && units >= policy.minSell && units <= policy.maxSell);
  });
  for (const p of presets) kb.text(`${p}%/${p}%`, `pre:tax:${p}`);
  if (presets.length) kb.row();

  kb.text('🧮 Pembagian creator/dividen/burn', 'in:split:tax').row();
  SPLIT_PRESETS.forEach((preset, index) => kb.text(preset.label, `pre:split:${index}`));
  kb.row();

  if (BigInt(draft.tax.dividendShare) > 0n) {
    const floor = policy?.minHoldingFloor ?? 10_000n * 10n ** 18n;
    kb.text('🪙 Min. holding dividen', 'in:minHolding:tax').row();
    for (const tokens of HOLDING_PRESETS) {
      if (tokens * 10n ** 18n >= floor) kb.text(formatTokenAmount(tokens * 10n ** 18n), `pre:hold:${tokens}`);
    }
    kb.row();
  }
  if (!policy || policy.antiSnipeWindowSeconds > 0) {
    kb.text(`🛡 Anti-snipe: ${draft.tax.antiSnipe ? 'ON' : 'OFF'}`, 'tog:anti').row();
  }
  kb.text('📥 Penerima creator fee', 'in:recipient:tax').text('👛 Pakai wallet bot', 'pre:self').row();
  return kb.text('⬅ Kembali', 'nav:dash');
}

export function devKeyboard(draft: Draft): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(`💰 Dev Buy: ${draft.devBuy.enabled ? 'ON ✅' : 'OFF'}`, 'tog:dev')
    .row()
    .text(`Jumlah${mark(!!draft.devBuy.amountRaw)}`, 'in:devAmount:dev')
    .row();
  for (const bps of SLIPPAGE_PRESETS_BPS) {
    kb.text(`${draft.devBuy.slippageBps === bps ? '✅ ' : ''}${formatPercent(BigInt(bps) * 10_000n)}%`, `pre:slip:${bps}`);
  }
  kb.text('Slippage lain', 'in:devSlippage:dev')
    .row()
    .text(`⏱ Waktu: ${draft.devBuy.timing === 'auto' ? 'tunggu anti-snipe' : 'segera'}`, 'tog:timing')
    .row()
    .text('⬅ Kembali', 'nav:dash');
  return kb;
}

export function pairKeyboard(
  all: QuoteConfiguration[],
  ui: PairUi,
  hasStocks: boolean,
  currentAddress: string | undefined,
): InlineKeyboard {
  const pages = Math.max(1, Math.ceil(all.length / PAIR_PAGE_SIZE));
  const page = Math.min(ui.page, pages - 1);
  const items = all.slice(page * PAIR_PAGE_SIZE, (page + 1) * PAIR_PAGE_SIZE);

  const counts = new Map<string, number>();
  for (const q of all) counts.set(q.symbol, (counts.get(q.symbol) ?? 0) + 1);

  const kb = new InlineKeyboard();
  if (hasStocks) {
    kb.text(`${ui.filter === 'crypto' ? '✅ ' : ''}🪙 Crypto`, 'pair:filter:crypto').text(`${ui.filter === 'stocks' ? '✅ ' : ''}📈 Stocks`, 'pair:filter:stocks').row();
  }
  items.forEach((q, index) => {
    const selected = q.address.toLowerCase() === currentAddress?.toLowerCase();
    const label = (counts.get(q.symbol) ?? 0) > 1 ? `${q.symbol}·${q.address.slice(-4)}` : q.symbol;
    kb.text(`${selected ? '✅ ' : ''}${label}`, `pair:pick:${q.address}`);
    if (index % 2 === 1) kb.row();
  });
  if (items.length % 2 === 1) kb.row();
  if (pages > 1) {
    // Telegram rejects empty button labels, so disabled arrows use a middle dot.
    kb.text(page > 0 ? '‹ Sebelumnya' : '·', page > 0 ? `pair:page:${page - 1}` : 'noop')
      .text(`${page + 1}/${pages}`, 'noop')
      .text(page < pages - 1 ? 'Berikutnya ›' : '·', page < pages - 1 ? `pair:page:${page + 1}` : 'noop')
      .row();
  }
  kb.text('🔎 Cari', 'in:pairSearch:pair');
  if (ui.query) kb.text('❌ Hapus pencarian', 'pair:clearq');
  return kb.row().text('⬅ Kembali', 'nav:dash');
}

export function promptKeyboard(field: FieldKey, back: ViewName): InlineKeyboard {
  const kb = new InlineKeyboard().text('Batal', `cancel:${back}`);
  if (CLEARABLE_FIELDS.has(field)) kb.text('🗑 Hapus isi', `clr:${field}:${back}`);
  return kb;
}

export function reviewKeyboard(ok: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (ok) kb.text('🚀 Konfirmasi & Launch', 'go:launch').row();
  return kb.text('🔄 Cek ulang', 'nav:review').text('✏️ Edit draft', 'nav:dash');
}

export function resultKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🚀 Launch lagi', 'go:again');
}

export function failureKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('⬅ Kembali ke draft', 'nav:dash');
}
