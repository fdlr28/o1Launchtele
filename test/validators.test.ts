import { describe, expect, it } from 'vitest';
import { InputError } from '../src/domain/units.js';
import {
  IMAGE_MAX_BYTES,
  normalizeTelegram,
  normalizeWebsite,
  normalizeX,
  parseAddress,
  sniffImageType,
  validateDescription,
  validateImage,
  validateName,
  validateSymbol,
  TELEGRAM_PATTERN,
  WEBSITE_PATTERN,
  X_PATTERN,
} from '../src/domain/validators.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Uint8Array.from([...Buffer.from('GIF89a'), 0, 0]);
const WEBP = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), 0]);

describe('name and symbol', () => {
  it('trims and enforces limits by code point', () => {
    expect(validateName('  Pepe Coin  ')).toBe('Pepe Coin');
    expect(() => validateName('')).toThrow(InputError);
    expect(() => validateName('a'.repeat(51))).toThrow(/50/);
    expect(validateName('🐸'.repeat(50))).toHaveLength(100); // 50 emoji = 100 UTF-16 units, still allowed
    expect(() => validateName('🐸'.repeat(51))).toThrow(/50/);
    expect(() => validateName('bad\u0000name')).toThrow(InputError);
  });

  it('strips a leading $, rejects spaces and keeps casing', () => {
    expect(validateSymbol('$PePe')).toBe('PePe');
    expect(validateSymbol('  ABC ')).toBe('ABC');
    expect(() => validateSymbol('A B')).toThrow(/spasi/);
    expect(() => validateSymbol('')).toThrow(InputError);
    expect(() => validateSymbol('$')).toThrow(InputError);
    expect(() => validateSymbol('ABCDEFGHIJKL')).toThrow(/11/);
    expect(validateSymbol('ABCDEFGHIJK')).toBe('ABCDEFGHIJK');
  });

  it('limits the description by UTF-8 bytes', () => {
    expect(validateDescription('  hai  ')).toBe('hai');
    expect(validateDescription('a'.repeat(2000))).toHaveLength(2000);
    expect(() => validateDescription('a'.repeat(2001))).toThrow(InputError);
    expect(() => validateDescription('é'.repeat(1001))).toThrow(InputError); // 2 bytes each
  });
});

describe('links', () => {
  it('normalises websites and matches the API pattern', () => {
    expect(normalizeWebsite('example.com')).toBe('https://example.com');
    expect(normalizeWebsite('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
    expect(normalizeWebsite('')).toBe('');
    expect(WEBSITE_PATTERN.test(normalizeWebsite('sub.example.co.id/path'))).toBe(true);
    for (const bad of ['notaurl', 'javascript:alert(1)', 'ftp://example.com', 'https://', 'exa mple.com']) {
      expect(() => normalizeWebsite(bad), bad).toThrow(InputError);
    }
  });

  it('normalises X handles and links', () => {
    expect(normalizeX('@elon')).toBe('https://x.com/elon');
    expect(normalizeX('elon_musk')).toBe('https://x.com/elon_musk');
    expect(normalizeX('twitter.com/elon')).toBe('https://x.com/elon');
    expect(normalizeX('https://www.x.com/elon/')).toBe('https://x.com/elon');
    expect(normalizeX('https://x.com/i/communities/123')).toBe('https://x.com/i/communities/123');
    expect(X_PATTERN.test(normalizeX('@abc'))).toBe(true);
    expect(normalizeX('')).toBe('');
    for (const bad of ['https://x.com', 'https://evil.com/elon', 'a'.repeat(16), 'x.com']) {
      expect(() => normalizeX(bad), bad).toThrow(InputError);
    }
  });

  it('normalises Telegram handles and links', () => {
    expect(normalizeTelegram('@my_channel')).toBe('https://t.me/my_channel');
    expect(normalizeTelegram('t.me/mygroup')).toBe('https://t.me/mygroup');
    expect(normalizeTelegram('https://telegram.me/foo_bar')).toBe('https://t.me/foo_bar');
    expect(normalizeTelegram('https://t.me/+AbCdEf123')).toBe('https://t.me/+AbCdEf123');
    expect(TELEGRAM_PATTERN.test(normalizeTelegram('@abcde'))).toBe(true);
    for (const bad of ['https://t.me', 'https://evil.com/x', 'ab']) {
      expect(() => normalizeTelegram(bad), bad).toThrow(InputError);
    }
  });
});

describe('parseAddress', () => {
  it('accepts valid addresses and returns the checksummed form', () => {
    expect(parseAddress('0x52908400098527886E0F7030069857D2E4169EE7')).toBe('0x52908400098527886E0F7030069857D2E4169EE7');
    expect(parseAddress('0x52908400098527886e0f7030069857d2e4169ee7')).toBe('0x52908400098527886E0F7030069857D2E4169EE7');
  });

  it('rejects malformed, bad-checksum and zero addresses', () => {
    expect(() => parseAddress('0x123')).toThrow(InputError);
    expect(() => parseAddress('0x52908400098527886E0F7030069857D2E4169Ee7')).toThrow(InputError);
    expect(() => parseAddress('0x0000000000000000000000000000000000000000')).toThrow(/nol/);
  });
});

describe('images', () => {
  it('detects type from magic bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(Uint8Array.from([1, 2, 3, 4]))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg></svg>'))).toBeNull();
  });

  it('validates size and produces base64', () => {
    const image = validateImage(PNG);
    expect(image.type).toBe('image/png');
    expect(Buffer.from(image.base64, 'base64')).toEqual(Buffer.from(PNG));
    expect(() => validateImage(new Uint8Array())).toThrow(InputError);
    expect(() => validateImage(Buffer.from('not an image'))).toThrow(/Format gambar/);
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set(PNG);
    expect(() => validateImage(big)).toThrow(/terlalu besar/);
  });
});
