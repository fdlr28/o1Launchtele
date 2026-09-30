import { formatUnits, type Address } from 'viem';
import type { ContractSuite, InclusiveTaxLaunchSettings, InclusiveTaxPolicy } from '../o1/types.js';
import { ONE_PERCENT, PERCENT_SCALE, formatPercent, formatTokenAmount } from './units.js';

/**
 * User-chosen tax configuration. All numbers are decimal strings so a draft stays JSON-serialisable:
 *  - rates / shares use o1's percentage units (1_000_000 = 1%, 100_000_000 = 100%)
 *  - minHolding is in raw launch-token units (18 decimals)
 */
export interface TaxSettings {
  buyRate: string;
  sellRate: string;
  creatorShare: string;
  dividendShare: string;
  burnShare: string;
  minHolding: string;
  antiSnipe: boolean;
  creatorRecipient: Address;
}

/** Parsed policy from /config, with every value as bigint. */
export interface TaxPolicy {
  minBuy: bigint;
  maxBuy: bigint;
  minSell: bigint;
  maxSell: bigint;
  protocolShare: bigint;
  protocolMin: bigint;
  protocolMax: bigint;
  antiSnipeWindowSeconds: number;
  minHoldingFloor: bigint;
}

export function readTaxPolicy(suite: Pick<ContractSuite, 'tax_policy'>): TaxPolicy | null {
  const policy = suite.tax_policy as InclusiveTaxPolicy | undefined;
  if (!policy || policy.format !== 'inclusive') return null;
  try {
    return {
      minBuy: BigInt(policy.tax_fee_bounds.minimum_buy_tax_rate),
      maxBuy: BigInt(policy.tax_fee_bounds.maximum_buy_tax_rate),
      minSell: BigInt(policy.tax_fee_bounds.minimum_sell_tax_rate),
      maxSell: BigInt(policy.tax_fee_bounds.maximum_sell_tax_rate),
      protocolShare: BigInt(policy.protocol_fee_configuration.protocol_tax_share),
      protocolMin: BigInt(policy.protocol_fee_configuration.minimum_protocol_fee_rate),
      protocolMax: BigInt(policy.protocol_fee_configuration.maximum_protocol_fee_rate),
      antiSnipeWindowSeconds: Number(policy.anti_snipe_configuration.window_seconds),
      minHoldingFloor: BigInt(policy.minimum_dividend_holding_requirement_raw),
    };
  } catch {
    return null;
  }
}

export const DEFAULT_TAX_PERCENT = 3n * ONE_PERCENT;

export function defaultTaxSettings(recipient: Address): TaxSettings {
  return {
    buyRate: DEFAULT_TAX_PERCENT.toString(),
    sellRate: DEFAULT_TAX_PERCENT.toString(),
    creatorShare: PERCENT_SCALE.toString(),
    dividendShare: '0',
    burnShare: '0',
    minHolding: '0',
    antiSnipe: true,
    creatorRecipient: recipient,
  };
}

/** Protocol fee for one side, as a rate scaled by RATE_SCALE * PERCENT_SCALE (see docs formula). */
function protocolP2(total: bigint, policy: TaxPolicy): bigint {
  const raw = total * policy.protocolShare;
  const floor = policy.protocolMin * PERCENT_SCALE;
  const ceil = policy.protocolMax * PERCENT_SCALE;
  const clamped = raw > floor ? raw : floor;
  return clamped < ceil ? clamped : ceil;
}

/** Whether a side leaves anything to split between creator / dividends / burn after protocol. */
export function hasRemainder(total: bigint, policy: TaxPolicy): boolean {
  return total > 0n && total * PERCENT_SCALE > protocolP2(total, policy);
}

/** All values are per-trade rates scaled by RATE_SCALE (10^24 = 100% of trade value). */
export interface SideBreakdown {
  total: bigint;
  protocol: bigint;
  creator: bigint;
  dividend: bigint;
  burn: bigint;
}

export function sideBreakdown(total: bigint, settings: TaxSettings, policy: TaxPolicy): SideBreakdown {
  if (total === 0n) return { total: 0n, protocol: 0n, creator: 0n, dividend: 0n, burn: 0n };
  const p2 = protocolP2(total, policy);
  const r2 = total * PERCENT_SCALE - p2;
  const remainder = r2 > 0n ? r2 : 0n;
  return {
    total: total * PERCENT_SCALE * PERCENT_SCALE,
    protocol: p2 * PERCENT_SCALE,
    creator: remainder * BigInt(settings.creatorShare),
    dividend: remainder * BigInt(settings.dividendShare),
    burn: remainder * BigInt(settings.burnShare),
  };
}

/** 10^24-scaled rate -> "0.5" (percent, up to 4 decimals, trailing zeros trimmed). */
export function formatRate(rate: bigint): string {
  const text = formatUnits(rate, 22);
  const [whole = '0', frac = ''] = text.split('.');
  const trimmed = frac.slice(0, 4).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/**
 * Returns the settings exactly as they will be sent to the API:
 *  - if neither side leaves a remainder, all allocation shares and the minimum holding must be zero
 *  - with no dividend allocation the minimum holding must be zero
 */
export function effectiveTaxSettings(settings: TaxSettings, policy: TaxPolicy): TaxSettings {
  const buy = BigInt(settings.buyRate);
  const sell = BigInt(settings.sellRate);
  if (!hasRemainder(buy, policy) && !hasRemainder(sell, policy)) {
    return { ...settings, creatorShare: '0', dividendShare: '0', burnShare: '0', minHolding: '0' };
  }
  if (BigInt(settings.dividendShare) === 0n) return { ...settings, minHolding: '0' };
  return settings;
}

/** Returns human readable (Indonesian) problems; an empty list means valid. */
export function validateTaxSettings(settings: TaxSettings, policy: TaxPolicy, supplyRaw: bigint | null): string[] {
  const problems: string[] = [];
  const buy = BigInt(settings.buyRate);
  const sell = BigInt(settings.sellRate);

  const checkSide = (label: string, value: bigint, min: bigint, max: bigint) => {
    if (value < min || value > max) {
      problems.push(`${label} harus antara ${formatPercent(min)}% dan ${formatPercent(max)}% (sekarang ${formatPercent(value)}%).`);
    } else if (value > 0n && value < policy.protocolMin) {
      problems.push(`${label} tidak boleh di bawah fee minimum protocol (${formatPercent(policy.protocolMin)}%).`);
    }
  };
  checkSide('Buy tax', buy, policy.minBuy, policy.maxBuy);
  checkSide('Sell tax', sell, policy.minSell, policy.maxSell);

  const shares = [BigInt(settings.creatorShare), BigInt(settings.dividendShare), BigInt(settings.burnShare)];
  const remainderExists = hasRemainder(buy, policy) || hasRemainder(sell, policy);
  if (remainderExists) {
    const sum = shares.reduce((a, b) => a + b, 0n);
    if (sum !== PERCENT_SCALE) {
      problems.push(`Pembagian creator/dividen/burn harus total 100% (sekarang ${formatPercent(sum)}%).`);
    }
    if (BigInt(settings.dividendShare) > 0n) {
      const minHolding = BigInt(settings.minHolding);
      if (minHolding < policy.minHoldingFloor) {
        problems.push(`Min. holding dividen minimal ${formatTokenAmount(policy.minHoldingFloor)} token.`);
      }
      if (supplyRaw !== null && minHolding > supplyRaw) {
        problems.push('Min. holding dividen tidak boleh melebihi total supply.');
      }
    }
  }

  if (settings.antiSnipe && policy.antiSnipeWindowSeconds <= 0) {
    problems.push('Anti-snipe belum tersedia di chain ini.');
  }
  return problems;
}

/** Builds the `tax` object of POST /launches/prepare from validated, normalised settings. */
export function toApiTax(settings: TaxSettings): InclusiveTaxLaunchSettings {
  return {
    format: 'inclusive',
    buy_tax_rate: settings.buyRate,
    sell_tax_rate: settings.sellRate,
    creator_allocation_share: settings.creatorShare,
    burn_allocation_share: settings.burnShare,
    dividend_allocation_share: settings.dividendShare,
    integrator_allocation_share: '0',
    minimum_dividend_holding_raw: settings.minHolding,
    creator_fee_recipient: settings.creatorRecipient,
    integrator_fee_recipient: '0x0000000000000000000000000000000000000000',
    anti_snipe_enabled: settings.antiSnipe,
  };
}

export const SPLIT_PRESETS: ReadonlyArray<{ label: string; creator: bigint; dividend: bigint; burn: bigint }> = [
  { label: '100/0/0', creator: PERCENT_SCALE, dividend: 0n, burn: 0n },
  { label: '50/50/0', creator: PERCENT_SCALE / 2n, dividend: PERCENT_SCALE / 2n, burn: 0n },
  { label: '0/100/0', creator: 0n, dividend: PERCENT_SCALE, burn: 0n },
  { label: '0/0/100', creator: 0n, dividend: 0n, burn: PERCENT_SCALE },
];

/** Multi-line summary used on the dashboard and review screens. */
export function describeTax(settings: TaxSettings, policy: TaxPolicy | null): string[] {
  const buy = BigInt(settings.buyRate);
  const sell = BigInt(settings.sellRate);
  const lines = [
    `Buy ${formatPercent(buy)}% · Sell ${formatPercent(sell)}%`,
    `Sisa setelah protocol: creator ${formatPercent(BigInt(settings.creatorShare))}% · dividen ${formatPercent(BigInt(settings.dividendShare))}% · burn ${formatPercent(BigInt(settings.burnShare))}%`,
  ];
  if (policy) {
    const eff = effectiveTaxSettings(settings, policy);
    const b = sideBreakdown(buy, eff, policy);
    lines.push(
      `Per trade beli: protocol ${formatRate(b.protocol)}% · creator ${formatRate(b.creator)}% · dividen ${formatRate(b.dividend)}% · burn ${formatRate(b.burn)}%`,
    );
    if (sell !== buy) {
      const s = sideBreakdown(sell, eff, policy);
      lines.push(
        `Per trade jual: protocol ${formatRate(s.protocol)}% · creator ${formatRate(s.creator)}% · dividen ${formatRate(s.dividend)}% · burn ${formatRate(s.burn)}%`,
      );
    }
  }
  if (BigInt(settings.dividendShare) > 0n) {
    lines.push(`Min. holding dividen: ${formatTokenAmount(BigInt(settings.minHolding))} token`);
  }
  lines.push(`Anti-snipe: ${settings.antiSnipe ? 'ON' : 'OFF'}`);
  return lines;
}

