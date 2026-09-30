import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import { InputError } from './units.js';

export const NAME_MAX = 50;
export const SYMBOL_MAX = 11;
export const DESCRIPTION_MAX_BYTES = 2000;
/** o1 allows 2 MB; stay slightly under to be safe about MB vs MiB. */
export const IMAGE_MAX_BYTES = 2_000_000;
export const URL_MAX = 2048;

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

const codePoints = (value: string): number => [...value].length;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validateName(input: string): string {
  const name = input.trim();
  if (!name) throw new InputError('Nama tidak boleh kosong.');
  if (codePoints(name) > NAME_MAX) throw new InputError(`Nama maksimal ${NAME_MAX} karakter.`);
  if (CONTROL_CHARS.test(name)) throw new InputError('Nama mengandung karakter kontrol.');
  return name;
}

/** Strips a leading "$" (people type $PEPE) and rejects whitespace. Casing is preserved. */
export function validateSymbol(input: string): string {
  const symbol = input.trim().replace(/^\$/, '');
  if (!symbol) throw new InputError('Simbol tidak boleh kosong.');
  if (/\s/.test(symbol)) throw new InputError('Simbol tidak boleh mengandung spasi.');
  if (codePoints(symbol) > SYMBOL_MAX) throw new InputError(`Simbol maksimal ${SYMBOL_MAX} karakter.`);
  if (CONTROL_CHARS.test(symbol)) throw new InputError('Simbol mengandung karakter kontrol.');
  return symbol;
}

export function validateDescription(input: string): string {
  const description = input.trim();
  if (Buffer.byteLength(description, 'utf8') > DESCRIPTION_MAX_BYTES) {
    throw new InputError(`Deskripsi maksimal ${DESCRIPTION_MAX_BYTES} byte (sekitar 2000 karakter latin).`);
  }
  return description;
}

// Same patterns as the o1 OpenAPI schema for LaunchPrepareRequest.token.
export const WEBSITE_PATTERN = /^https?:\/\/[^/]*\.[^/]+(?:\/.*)?$/;
export const X_PATTERN = /^https?:\/\/(?:www\.)?x\.com\/.+/;
export const TELEGRAM_PATTERN = /^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/.+/;

function withScheme(input: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
}

function parseUrl(input: string): URL {
  try {
    return new URL(withScheme(input));
  } catch {
    throw new InputError('Link tidak valid.');
  }
}

/** Empty string clears the field. */
export function normalizeWebsite(input: string): string {
  const text = input.trim();
  if (!text) return '';
  const url = parseUrl(text);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InputError('Website harus diawali http:// atau https://');
  }
  const value = withScheme(text);
  if (value.length > URL_MAX) throw new InputError('Link terlalu panjang.');
  if (!WEBSITE_PATTERN.test(value)) throw new InputError('Website tidak valid. Contoh: https://contoh.com');
  return value;
}

const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

/** Accepts @handle, handle, x.com/handle or twitter.com/handle and returns an https://x.com URL. */
export function normalizeX(input: string): string {
  const text = input.trim();
  if (!text) return '';
  const handle = /^@?([A-Za-z0-9_]{1,15})$/.exec(text);
  if (handle) return `https://x.com/${handle[1]}`;
  const url = parseUrl(text);
  if (!X_HOSTS.has(url.hostname.toLowerCase())) {
    throw new InputError('Link X harus dari x.com atau twitter.com, atau tulis @username.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '') throw new InputError('Link X harus menyertakan username.');
  const value = `https://x.com${path}`;
  if (!X_PATTERN.test(value)) throw new InputError('Link X tidak valid.');
  return value;
}

const TELEGRAM_HOSTS = new Set(['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me']);

/** Accepts @name, name, t.me/name or telegram.me/name and returns an https://t.me URL. */
export function normalizeTelegram(input: string): string {
  const text = input.trim();
  if (!text) return '';
  const handle = /^@?([A-Za-z0-9_]{4,32})$/.exec(text);
  if (handle) return `https://t.me/${handle[1]}`;
  const url = parseUrl(text);
  if (!TELEGRAM_HOSTS.has(url.hostname.toLowerCase())) {
    throw new InputError('Link Telegram harus dari t.me atau telegram.me, atau tulis @username.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) throw new InputError('Link Telegram harus menyertakan username atau invite.');
  const value = `https://t.me${path}`;
  if (!TELEGRAM_PATTERN.test(value)) throw new InputError('Link Telegram tidak valid.');
  return value;
}

/** Non-zero checksummed address. */
export function parseAddress(input: string): Address {
  const text = input.trim();
  if (!isAddress(text)) throw new InputError('Alamat wallet tidak valid (harus 0x + 40 karakter hex).');
  const address = getAddress(text);
  if (address === zeroAddress) throw new InputError('Alamat nol tidak diperbolehkan.');
  return address;
}

/** Detects the image type from magic bytes; we never trust Telegram's mime type. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
    && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export interface ValidImage {
  type: ImageType;
  base64: string;
  bytes: number;
}

export function validateImage(bytes: Uint8Array): ValidImage {
  if (bytes.length === 0) throw new InputError('File gambar kosong.');
  if (bytes.length > IMAGE_MAX_BYTES) {
    throw new InputError(`Gambar terlalu besar (${(bytes.length / 1e6).toFixed(2)} MB). Maksimal 2 MB.`);
  }
  const type = sniffImageType(bytes);
  if (!type) throw new InputError('Format gambar tidak didukung. Gunakan PNG, JPG, WEBP, atau GIF.');
  return { type, base64: Buffer.from(bytes).toString('base64'), bytes: bytes.length };
}
