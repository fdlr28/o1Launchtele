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

describe('ambiguous thousands separators', () => {
  it('refuses to guess between "1.000 = one thousand" and "1.000 = one"', () => {
    for (const bad of ['1.000', '1,000', '10.000', '10,000', '250,500', '999.999', ' 1 .000 ']) {
      expect(() => parseAssetAmount(bad, 18), bad).toThrow(/ambigu/);
      expect(() => parseTokenAmount(bad), bad).toThrow(/ambigu/);
    }
  });

  it('says how to write it unambiguously', () => {
    expect(() => parseAssetAmount('1.500', 18)).toThrow(/Tulis 1500 untuk ribuan, atau 1.5000 untuk desimal/);
    expect(() => parseTokenAmount('10,000')).toThrow(/Tulis 10000 untuk ribuan, atau 10.0000 untuk desimal/);
  });

  it('still accepts everything that can only mean one thing', () => {
    expect(parseAssetAmount('0.005', 18)).toBe(5_000_000_000_000_000n); // a leading zero cannot be a thousands group
    expect(parseAssetAmount('0,050', 18)).toBe(50_000_000_000_000_000n);
    expect(parseAssetAmount('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseAssetAmount('1.50', 6)).toBe(1_500_000n);
    expect(parseAssetAmount('1.5000', 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseAssetAmount('1500', 6)).toBe(1_500_000_000n);
    expect(parseAssetAmount('12.34567', 18)).toBe(12_345_670_000_000_000_000n);
    expect(parseTokenAmount('10000')).toBe(10_000n * 10n ** 18n);
    expect(parseTokenAmount('1.000k')).toBe(1_000n * 10n ** 18n); // a suffix leaves no doubt
    expect(parseTokenAmount('0.001')).toBe(10n ** 15n);
  });

  it('does not touch percentages', () => {
    expect(parsePercent('1.000')).toBe(1_000_000n);
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
  it('never shows a small non-zero amount as zero', () => {
    expect(formatAmount(1n, 18)).toBe('<0.000001');
    expect(formatAmount(100_000_000_000n, 18)).toBe('<0.000001'); // 1e-7
    expect(formatAmount(1n, 6)).toBe('0.000001'); // exactly representable
    expect(formatAmount(50n, 18, 4)).toBe('<0.0001');
    expect(formatAmount(0n, 18)).toBe('0');
    expect(formatAmount(1_500_000_000_000n, 18)).toBe('0.000001'); // shown digits are truncated, never rounded up
  });

  it('trims trailing zeros and caps fraction digits', () => {
    expect(formatAmount(1_000_000_000_000_000n, 18)).toBe('0.001');
    expect(formatAmount(1_500_000n, 6)).toBe('1.5');
    expect(formatAmount(2n * 10n ** 18n, 18)).toBe('2');
    expect(formatAmount(123_456_789_012_345_678n, 18, 4)).toBe('0.1234');
  });
});
