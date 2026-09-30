import { describe, expect, it } from 'vitest';
import {
  InputError,
  formatAmount,
  formatPercent,
  formatTokenAmount,
  parseAssetAmount,
  parsePercent,
  parseTokenAmount,
} from '../src/domain/units.js';

describe('parsePercent', () => {
  it('parses exactly, without floating point', () => {
    expect(parsePercent('3')).toBe(3_000_000n);
    expect(parsePercent('2.5')).toBe(2_500_000n);
    expect(parsePercent('0.000001')).toBe(1n);
    expect(parsePercent('100')).toBe(100_000_000n);
    expect(parsePercent('0.1')).toBe(100_000n); // 0.1 is inexact as a float
    expect(parsePercent('0.7')).toBe(700_000n);
  });

  it('accepts a comma decimal separator and a trailing percent sign', () => {
    expect(parsePercent('2,5%')).toBe(2_500_000n);
    expect(parsePercent(' 5 % ')).toBe(5_000_000n);
  });

  it('rejects invalid input', () => {
    for (const bad of ['', 'abc', '-1', '100.1', '1.1234567', '1..2', '1,2,3', '%']) {
      expect(() => parsePercent(bad), bad).toThrow(InputError);
    }
  });

  it('round-trips through formatPercent', () => {
    for (const text of ['3', '2.5', '0.000001', '99.999999', '100']) {
      expect(formatPercent(parsePercent(text))).toBe(text);
    }
  });
});

describe('parseAssetAmount', () => {
  it('converts to base units', () => {
    expect(parseAssetAmount('0.05', 18)).toBe(50_000_000_000_000_000n);
    expect(parseAssetAmount('0,05', 18)).toBe(50_000_000_000_000_000n);
    expect(parseAssetAmount('100', 6)).toBe(100_000_000n);
    expect(parseAssetAmount('1.5', 8)).toBe(150_000_000n);
  });

  it('rejects zero, extra precision and thousands separators', () => {
    expect(() => parseAssetAmount('0', 18)).toThrow(InputError);
    expect(() => parseAssetAmount('0.0000001', 6)).toThrow(/desimal/);
    expect(() => parseAssetAmount('1,000.5', 18)).toThrow(InputError);
    expect(() => parseAssetAmount('1.000,5', 18)).toThrow(InputError);
    expect(() => parseAssetAmount('abc', 18)).toThrow(InputError);
    expect(() => parseAssetAmount('-1', 18)).toThrow(InputError);
  });
});

describe('parseTokenAmount', () => {
  it('handles plain numbers and k / m / b suffixes exactly', () => {
    const ten = 10n ** 18n;
    expect(parseTokenAmount('10000')).toBe(10_000n * ten);
    expect(parseTokenAmount('10k')).toBe(10_000n * ten);
    expect(parseTokenAmount('2.5m')).toBe(2_500_000n * ten);
    expect(parseTokenAmount('1B')).toBe(1_000_000_000n * ten);
    expect(parseTokenAmount('0.5k')).toBe(500n * ten);
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'k', '10x', '1e5', '-5', '10.000.000']) {
      expect(() => parseTokenAmount(bad), bad).toThrow(InputError);
    }
  });

  it('formats with thousands separators', () => {
    expect(formatTokenAmount(10_000n * 10n ** 18n)).toBe('10,000');
    expect(formatTokenAmount(1_000_000_000n * 10n ** 18n)).toBe('1,000,000,000');
  });
});

describe('formatAmount', () => {
  it('trims trailing zeros and caps fraction digits', () => {
    expect(formatAmount(1_000_000_000_000_000n, 18)).toBe('0.001');
    expect(formatAmount(1_500_000n, 6)).toBe('1.5');
    expect(formatAmount(2n * 10n ** 18n, 18)).toBe('2');
    expect(formatAmount(123_456_789_012_345_678n, 18, 4)).toBe('0.1234');
  });
});
