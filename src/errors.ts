import { formatUnits, zeroAddress } from 'viem';
import { InputError } from './domain/units.js';
import { ApiError } from './o1/client.js';

/** An error whose message is safe and meant to be shown to the Telegram user verbatim. */
export class UserFacingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UserFacingError';
  }
}

/** A transaction we broadcast, so the user can look it up on the explorer. */
export class TxError extends UserFacingError {
  constructor(
    message: string,
    public readonly txHash: string,
    public readonly chainId: number,
  ) {
    super(message);
    this.name = 'TxError';
  }
}

/** Mined, but reverted. */
export class TxRevertedError extends TxError {}

/** Broadcast, but no receipt within the timeout. It may still confirm: never resend blindly. */
export class TxUnknownError extends TxError {}

/** Plain-text (not HTML-escaped) description of any error, in Indonesian. */
export function describeError(err: unknown): string {
  if (err instanceof UserFacingError || err instanceof InputError) return err.message;
  if (err instanceof ApiError) return describeApiError(err);
  if (err instanceof Error) {
    // viem errors carry a concise, human friendly `shortMessage`.
    const short = (err as { shortMessage?: string }).shortMessage;
    return `Terjadi kesalahan: ${firstLine(short ?? err.message)}`;
  }
  return `Terjadi kesalahan: ${String(err)}`;
}

function describeApiError(err: ApiError): string {
  const p = err.problem;
  const lines: string[] = [];

  switch (err.code) {
    case 'insufficient_balance': {
      const native = p?.asset?.toLowerCase() === zeroAddress;
      const fmt = (raw?: string) => (raw === undefined ? '?' : native ? formatUnits(BigInt(raw), 18) : raw);
      lines.push(`Saldo kurang${native ? '' : ` untuk aset ${p?.asset}`}: punya ${fmt(p?.actual_raw)}, butuh ${fmt(p?.required_raw)}${native ? ' (native)' : ' (satuan terkecil)'}.`);
      break;
    }
    case 'rate_limit_exceeded':
    case 'quota_exceeded':
      lines.push(`Batas rate API o1 tercapai. Coba lagi ${err.retryAfterSec ? `dalam ${err.retryAfterSec} detik` : 'sebentar lagi'}.`);
      break;
    case 'missing_api_key':
    case 'invalid_api_key':
      lines.push('API key o1 ditolak. Periksa O1_API_KEY di file .env (buat key baru di launch.o1.exchange/developers).');
      break;
    case 'insufficient_scope':
      lines.push(`API key belum punya scope yang dibutuhkan. ${p?.detail ?? ''}`.trim());
      break;
    case 'network_error':
      lines.push(err.message);
      break;
    default:
      lines.push(p?.detail ?? p?.title ?? err.message);
  }

  if (p?.action && err.code !== 'insufficient_balance') lines.push(`➡ ${p.action}`);
  const ref = [err.code, err.requestId ? `req ${err.requestId}` : ''].filter(Boolean).join(' · ');
  lines.push(`(${ref})`);
  return lines.join('\n');
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 400) ?? text;
}
