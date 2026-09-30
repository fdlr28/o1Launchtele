import type { Draft, DraftQuote } from '../domain/draft.js';
import { SPLIT_PRESETS, type TaxPolicy } from '../domain/tax.js';
import {
  InputError,
  PERCENT_SCALE,
  formatPercent,
  formatTokenAmount,
  parseAssetAmount,
  parsePercent,
  parseTokenAmount,
} from '../domain/units.js';
import {
  normalizeTelegram,
  normalizeWebsite,
  normalizeX,
  parseAddress,
  validateDescription,
  validateName,
  validateSymbol,
} from '../domain/validators.js';
import type { FieldKey } from './state.js';

/** What the tax validators may need to know about the selected chain. */
export interface FieldEnv {
  taxPolicy: TaxPolicy | null;
  supplyRaw: bigint | null;
}

/** Fields whose value can be removed again. */
export const CLEARABLE_FIELDS: ReadonlySet<FieldKey> = new Set(['description', 'website', 'x', 'telegram']);

/** Used when the chain's policy is unavailable: 10,000 tokens (the documented factory floor). */
const FALLBACK_HOLDING_FLOOR = 10_000n * 10n ** 18n;

const isClear = (text: string) => text.trim() === '-' || text.trim() === '';

function assertTaxInRange(label: string, value: bigint, min: bigint, max: bigint, protocolMin: bigint): void {
  if (value < min || value > max) {
    throw new InputError(`${label} harus antara ${formatPercent(min)}% dan ${formatPercent(max)}%.`);
  }
  if (value > 0n && value < protocolMin) {
    throw new InputError(`${label} tidak boleh di bawah fee minimum protocol (${formatPercent(protocolMin)}%).`);
  }
}

export function holdingFloor(env: FieldEnv): bigint {
  return env.taxPolicy?.minHoldingFloor ?? FALLBACK_HOLDING_FLOOR;
}

/** Keeps the dividend holding threshold consistent with the dividend share. */
function syncMinHolding(draft: Draft, env: FieldEnv): void {
  if (BigInt(draft.tax.dividendShare) === 0n) {
    draft.tax.minHolding = '0';
  } else if (BigInt(draft.tax.minHolding) < holdingFloor(env)) {
    draft.tax.minHolding = holdingFloor(env).toString();
  }
}

/** Applies a typed value to the draft. Throws InputError with a user-facing message when invalid. */
export function applyTextField(draft: Draft, field: FieldKey, text: string, env: FieldEnv): void {
  switch (field) {
    case 'name':
      draft.name = validateName(text);
      return;
    case 'symbol':
      draft.symbol = validateSymbol(text);
      return;
    case 'description':
      draft.description = isClear(text) ? '' : validateDescription(text);
      return;
    case 'website':
      draft.website = isClear(text) ? '' : normalizeWebsite(text);
      return;
    case 'x':
      draft.x = isClear(text) ? '' : normalizeX(text);
      return;
    case 'telegram':
      draft.telegram = isClear(text) ? '' : normalizeTelegram(text);
      return;
    case 'buyTax': {
      const value = parsePercent(text);
      if (env.taxPolicy) assertTaxInRange('Buy tax', value, env.taxPolicy.minBuy, env.taxPolicy.maxBuy, env.taxPolicy.protocolMin);
      draft.tax.buyRate = value.toString();
      return;
    }
    case 'sellTax': {
      const value = parsePercent(text);
      if (env.taxPolicy) assertTaxInRange('Sell tax', value, env.taxPolicy.minSell, env.taxPolicy.maxSell, env.taxPolicy.protocolMin);
      draft.tax.sellRate = value.toString();
      return;
    }
    case 'split': {
      const parts = text.trim().split(/[\s/:;-]+/).filter(Boolean);
      if (parts.length !== 3) throw new InputError('Kirim 3 angka: creator/dividen/burn. Contoh: 60/40/0');
      const [creator, dividend, burn] = parts.map(parsePercent) as [bigint, bigint, bigint];
      if (creator + dividend + burn !== PERCENT_SCALE) {
        throw new InputError(`Total harus 100% (sekarang ${formatPercent(creator + dividend + burn)}%).`);
      }
      draft.tax.creatorShare = creator.toString();
      draft.tax.dividendShare = dividend.toString();
      draft.tax.burnShare = burn.toString();
      syncMinHolding(draft, env);
      return;
    }
    case 'minHolding': {
      const value = parseTokenAmount(text);
      if (value < holdingFloor(env)) throw new InputError(`Minimal ${formatTokenAmount(holdingFloor(env))} token.`);
      if (env.supplyRaw !== null && value > env.supplyRaw) throw new InputError('Tidak boleh melebihi total supply.');
      draft.tax.minHolding = value.toString();
      return;
    }
    case 'recipient':
      draft.tax.creatorRecipient = parseAddress(text);
      return;
    case 'devAmount': {
      if (!draft.quote) throw new InputError('Pilih pair dulu sebelum mengisi jumlah dev buy.');
      draft.devBuy.amountRaw = parseAssetAmount(text, draft.quote.decimals).toString();
      return;
    }
    case 'devSlippage': {
      const units = parsePercent(text);
      if (units % 10_000n !== 0n) throw new InputError('Slippage maksimal 2 desimal (contoh 2.5).');
      const bps = Number(units / 10_000n);
      if (bps < 1 || bps > 4999) throw new InputError('Slippage harus antara 0.01% dan 49.99%.');
      draft.devBuy.slippageBps = bps;
      return;
    }
    default:
      throw new InputError('Field ini tidak menerima teks.');
  }
}

export function clearField(draft: Draft, field: FieldKey): void {
  if (field === 'description') draft.description = '';
  else if (field === 'website') draft.website = '';
  else if (field === 'x') draft.x = '';
  else if (field === 'telegram') draft.telegram = '';
}

/** Changing the pair invalidates a dev buy amount typed in another asset's units. */
export function setQuote(draft: Draft, quote: DraftQuote | null): void {
  const changed = !draft.quote || !quote || draft.quote.address.toLowerCase() !== quote.address.toLowerCase() || draft.quote.decimals !== quote.decimals;
  draft.quote = quote;
  if (changed) draft.devBuy.amountRaw = null;
}

/** Sets buy and sell tax to the same percentage (quick preset). */
export function presetTax(draft: Draft, percent: bigint, env: FieldEnv): void {
  applyTextField(draft, 'buyTax', formatPercent(percent), env);
  applyTextField(draft, 'sellTax', formatPercent(percent), env);
}

export function presetSplit(draft: Draft, index: number, env: FieldEnv): void {
  const preset = SPLIT_PRESETS[index];
  if (!preset) throw new InputError('Preset tidak dikenal.');
  draft.tax.creatorShare = preset.creator.toString();
  draft.tax.dividendShare = preset.dividend.toString();
  draft.tax.burnShare = preset.burn.toString();
  syncMinHolding(draft, env);
}

/** Percent typed by the user (or a preset in bps) -> slippage. */
export function presetSlippage(draft: Draft, bps: number): void {
  if (!Number.isInteger(bps) || bps < 1 || bps > 4999) throw new InputError('Slippage tidak valid.');
  draft.devBuy.slippageBps = bps;
}
