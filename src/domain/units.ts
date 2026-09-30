import { formatUnits, parseUnits } from 'viem';

/** o1 Tax percentage inputs: 100000000 = 100%, 1000000 = 1%, 1 = 0.000001%. */
export const PERCENT_SCALE = 100_000_000n;
/** Derived per-trade rates returned by the Hook use 10^24 = 100%. */
export const RATE_SCALE = 10n ** 24n;
export const PERCENT_DECIMALS = 6;
/** One percent expressed in PERCENT_SCALE units. */
export const ONE_PERCENT = 1_000_000n;

export class InputError extends Error {}

/** Normalises a user typed number: trims, accepts a comma decimal separator. */
function cleanNumber(text: string): string {
  return text.trim().replace(/\s+/g, '').replace(',', '.');
}

/** "2.5", "2,5" or "2.5%" -> 2_500_000n. Exact, at most 6 decimals, 0..100. */
export function parsePercent(text: string): bigint {
  const cleaned = cleanNumber(text).replace(/%$/, '');
  if (!/^\d+(\.\d{1,6})?$/.test(cleaned)) {
    throw new InputError('Format persen tidak valid. Contoh: 3 atau 2.5 (maks 6 desimal).');
  }
  const units = parseUnits(cleaned, PERCENT_DECIMALS);
  if (units > PERCENT_SCALE) throw new InputError('Persen tidak boleh lebih dari 100%.');
  return units;
}

/** 2_500_000n -> "2.5" (trailing zeros trimmed). */
export function formatPercent(units: bigint): string {
  return trimZeros(formatUnits(units, PERCENT_DECIMALS));
}

/** Positive decimal amount in an asset's base units. Rejects extra precision. */
export function parseAssetAmount(text: string, decimals: number): bigint {
  const cleaned = cleanNumber(text);
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new InputError('Format angka tidak valid. Gunakan titik atau koma sebagai desimal, tanpa pemisah ribuan.');
  }
  const fraction = cleaned.split('.')[1] ?? '';
  if (fraction.length > decimals) {
    throw new InputError(`Terlalu banyak desimal (maks ${decimals}).`);
  }
  const raw = parseUnits(cleaned, decimals);
  if (raw <= 0n) throw new InputError('Jumlah harus lebih dari 0.');
  return raw;
}

const SUFFIX: Record<string, number> = { k: 3, m: 6, b: 9 };

/** Launch-token amount (18 decimals). Accepts 10000, 10k, 2.5m, 1b. */
export function parseTokenAmount(text: string): bigint {
  const cleaned = cleanNumber(text).toLowerCase();
  const match = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(cleaned);
  if (!match) throw new InputError('Format jumlah token tidak valid. Contoh: 10000, 10k, 2.5m.');
  const digits = match[1] ?? '';
  const suffix = match[2];
  if ((digits.split('.')[1] ?? '').length > 18) throw new InputError('Terlalu banyak desimal (maks 18).');
  const base = parseUnits(digits, 18);
  return suffix ? base * 10n ** BigInt(SUFFIX[suffix] ?? 0) : base;
}

export function formatAmount(raw: bigint, decimals: number, maxFraction = 6): string {
  const full = formatUnits(raw, decimals);
  const [whole = '0', frac = ''] = full.split('.');
  const trimmed = frac.slice(0, maxFraction).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** 10000000000000000000000n (18 dec) -> "10,000". */
export function formatTokenAmount(raw: bigint): string {
  const text = formatAmount(raw, 18, 4);
  const [whole = '0', frac] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

function trimZeros(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}
