import { describe, expect, it } from 'vitest';
import {
  defaultTaxSettings,
  describeTax,
  effectiveTaxSettings,
  formatRate,
  hasRemainder,
  readTaxPolicy,
  sideBreakdown,
  toApiTax,
  validateTaxSettings,
  type TaxPolicy,
  type TaxSettings,
} from '../src/domain/tax.js';
import { ONE_PERCENT, PERCENT_SCALE } from '../src/domain/units.js';
import { RECIPIENT, TOKENS_10K, suite, taxPolicy } from './fixtures.js';

const policy = readTaxPolicy({ tax_policy: taxPolicy() }) as TaxPolicy;
const SUPPLY = 10n ** 27n;

function settings(overrides: Partial<TaxSettings> = {}): TaxSettings {
  return { ...defaultTaxSettings(RECIPIENT), ...overrides };
}

/** Percent -> o1 percentage units (1% = 1_000_000). Test inputs only; production parsing is string based. */
const pct = (n: number | string) => BigInt(Math.round(Number(n) * 1e6));

describe('readTaxPolicy', () => {
  it('parses the inclusive policy into bigints', () => {
    expect(policy.minBuy).toBe(1_000_000n);
    expect(policy.maxSell).toBe(10_000_000n);
    expect(policy.protocolShare).toBe(10_000_000n);
    expect(policy.protocolMin).toBe(500_000n);
    expect(policy.antiSnipeWindowSeconds).toBe(20);
    expect(policy.minHoldingFloor).toBe(BigInt(TOKENS_10K));
  });

  it('returns null for other formats or missing policy', () => {
    expect(readTaxPolicy({ tax_policy: undefined })).toBeNull();
    expect(readTaxPolicy({ tax_policy: { buy_min_bps: 0 } })).toBeNull();
    expect(readTaxPolicy(suite('non-tax'))).toBeNull();
  });
});

describe('sideBreakdown (matches the numbers published in the o1 docs)', () => {
  const at = (total: number, creator: number, dividend: number, burn: number) =>
    sideBreakdown(pct(total), settings({ creatorShare: pct(creator).toString(), dividendShare: pct(dividend).toString(), burnShare: pct(burn).toString() }), policy);

  it('1% total: protocol 0.5%, 0.5% left', () => {
    const b = at(1, 100, 0, 0);
    expect(formatRate(b.protocol)).toBe('0.5');
    expect(formatRate(b.creator)).toBe('0.5');
    expect(formatRate(b.total)).toBe('1');
  });

  it('3% total: protocol 0.5%, 2.5% left', () => {
    const b = at(3, 100, 0, 0);
    expect(formatRate(b.protocol)).toBe('0.5');
    expect(formatRate(b.creator)).toBe('2.5');
  });

  it('10% total: protocol 1%, 9% left', () => {
    const b = at(10, 100, 0, 0);
    expect(formatRate(b.protocol)).toBe('1');
    expect(formatRate(b.creator)).toBe('9');
  });

  it('docs example: 3% with a 60/40 creator/dividend split -> 1.5% creator, 1% dividends', () => {
    const b = at(3, 60, 40, 0);
    expect(formatRate(b.protocol)).toBe('0.5');
    expect(formatRate(b.creator)).toBe('1.5');
    expect(formatRate(b.dividend)).toBe('1');
    expect(formatRate(b.burn)).toBe('0');
  });

  it('the parts always add up to the total', () => {
    for (const total of [1, 2.5, 3, 7.777777, 10]) {
      const b = at(total, 33.333333, 33.333333, 33.333334);
      const sum = b.protocol + b.creator + b.dividend + b.burn;
      expect(sum).toBe(b.total);
    }
  });

  it('zero tax gives zero everywhere', () => {
    const b = sideBreakdown(0n, settings(), policy);
    expect(b).toEqual({ total: 0n, protocol: 0n, creator: 0n, dividend: 0n, burn: 0n });
  });
});

describe('hasRemainder', () => {
  it('is false when the protocol floor swallows the whole tax', () => {
    expect(hasRemainder(500_000n, policy)).toBe(false); // 0.5% == protocol floor
    expect(hasRemainder(600_000n, policy)).toBe(true);
    expect(hasRemainder(0n, policy)).toBe(false);
  });
});

describe('validateTaxSettings', () => {
  it('accepts the defaults', () => {
    expect(validateTaxSettings(settings(), policy, SUPPLY)).toEqual([]);
  });

  it('enforces the policy bounds on both sides', () => {
    const problems = validateTaxSettings(settings({ buyRate: pct(11).toString(), sellRate: pct(0.5).toString() }), policy, SUPPLY);
    expect(problems.some((p) => p.startsWith('Buy tax'))).toBe(true);
    expect(problems.some((p) => p.startsWith('Sell tax'))).toBe(true);
  });

  it('requires the split to add up to 100%', () => {
    const problems = validateTaxSettings(settings({ creatorShare: pct(60).toString(), dividendShare: pct(30).toString() }), policy, SUPPLY);
    expect(problems.join(' ')).toMatch(/100%/);
  });

  it('checks the dividend holding floor and the supply cap', () => {
    const dividends = { creatorShare: pct(50).toString(), dividendShare: pct(50).toString() };
    expect(validateTaxSettings(settings({ ...dividends, minHolding: '1' }), policy, SUPPLY).join(' ')).toMatch(/minimal/);
    expect(validateTaxSettings(settings({ ...dividends, minHolding: (SUPPLY + 1n).toString() }), policy, SUPPLY).join(' ')).toMatch(/supply/);
    expect(validateTaxSettings(settings({ ...dividends, minHolding: TOKENS_10K }), policy, SUPPLY)).toEqual([]);
  });

  it('rejects anti-snipe when the chain has no window', () => {
    const noWindow = readTaxPolicy({ tax_policy: taxPolicy({ anti_snipe_configuration: { start_total_fee_rate: '0', window_seconds: 0 } }) }) as TaxPolicy;
    expect(validateTaxSettings(settings({ antiSnipe: true }), noWindow, SUPPLY).join(' ')).toMatch(/Anti-snipe/);
    expect(validateTaxSettings(settings({ antiSnipe: false }), noWindow, SUPPLY)).toEqual([]);
  });
});

describe('effectiveTaxSettings / toApiTax', () => {
  it('zeroes the minimum holding when dividends are off', () => {
    const eff = effectiveTaxSettings(settings({ minHolding: TOKENS_10K }), policy);
    expect(eff.minHolding).toBe('0');
  });

  it('keeps the minimum holding when dividends are on', () => {
    const on = settings({ creatorShare: pct(50).toString(), dividendShare: pct(50).toString(), minHolding: TOKENS_10K });
    expect(effectiveTaxSettings(on, policy).minHolding).toBe(TOKENS_10K);
  });

  it('zeroes every allocation when no side has a remainder', () => {
    const tiny = readTaxPolicy({
      tax_policy: taxPolicy({
        tax_fee_bounds: { minimum_buy_tax_rate: '0', maximum_buy_tax_rate: '500000', minimum_sell_tax_rate: '0', maximum_sell_tax_rate: '500000' },
      }),
    }) as TaxPolicy;
    const eff = effectiveTaxSettings(settings({ buyRate: '500000', sellRate: '500000' }), tiny);
    expect([eff.creatorShare, eff.dividendShare, eff.burnShare, eff.minHolding]).toEqual(['0', '0', '0', '0']);
  });

  it('produces the exact API shape from the docs', () => {
    const api = toApiTax(settings({ buyRate: '3000000', sellRate: '3000000', creatorShare: '60000000', dividendShare: '40000000', minHolding: TOKENS_10K }));
    expect(api).toEqual({
      format: 'inclusive',
      buy_tax_rate: '3000000',
      sell_tax_rate: '3000000',
      creator_allocation_share: '60000000',
      burn_allocation_share: '0',
      dividend_allocation_share: '40000000',
      integrator_allocation_share: '0',
      minimum_dividend_holding_raw: TOKENS_10K,
      creator_fee_recipient: RECIPIENT,
      integrator_fee_recipient: '0x0000000000000000000000000000000000000000',
      anti_snipe_enabled: true,
    });
  });
});

describe('describeTax', () => {
  it('summarises the setup, including the per-trade split', () => {
    const lines = describeTax(settings({ creatorShare: pct(60).toString(), dividendShare: pct(40).toString(), minHolding: TOKENS_10K }), policy);
    const text = lines.join('\n');
    expect(text).toContain('Buy 3% · Sell 3%');
    expect(text).toContain('protocol 0.5% · creator 1.5% · dividen 1% · burn 0%');
    expect(text).toContain('Min. holding dividen: 10,000 token');
    expect(text).toContain('Anti-snipe: ON');
  });

  it('shows the sell side separately only when it differs', () => {
    const same = describeTax(settings(), policy).join('\n');
    expect(same).not.toContain('jual');
    const diff = describeTax(settings({ sellRate: pct(5).toString() }), policy).join('\n');
    expect(diff).toContain('Per trade jual');
  });
});

it('PERCENT_SCALE sanity', () => {
  expect(PERCENT_SCALE).toBe(100n * ONE_PERCENT);
});
