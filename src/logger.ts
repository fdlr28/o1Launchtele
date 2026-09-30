export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...extra: unknown[]): void;
  info(message: string, ...extra: unknown[]): void;
  warn(message: string, ...extra: unknown[]): void;
  error(message: string, ...extra: unknown[]): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Formats with a distinctive shape are redacted wherever they appear.
 * (Lookarounds instead of \b: Telegram file URLs embed the token as ".../bot<token>/...".)
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/o1_launch_[0-9a-f]{8}_[A-Za-z0-9_-]+/g, 'o1_launch_***'],
  [/(?<![0-9])\d{5,}:[A-Za-z0-9_-]{30,}/g, '<telegram-bot-token>'],
];

/**
 * Redacts known secrets and secret-shaped strings. A private key is indistinguishable from a
 * transaction hash by shape, so keys are removed by their exact value (with and without 0x),
 * which keeps transaction hashes readable in the logs.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  const exact = [...new Set(secrets.filter((s) => s.length >= 8))].sort((a, b) => b.length - a.length);
  for (const secret of exact) out = out.split(secret).join('<redacted>');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Every representation of a secret worth removing from logs (a private key with and without 0x). */
export function secretVariants(...values: string[]): string[] {
  return values.flatMap((value) => (value.startsWith('0x') ? [value, value.slice(2)] : [value]));
}

/**
 * The parts of a URL that may be a credential: RPC providers put an API key in the path or the query
 * (https://host/v2/<key>) or in the userinfo. A plain public endpoint has nothing to hide and stays readable.
 */
export function urlSecrets(value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  const carriesCredential = url.username !== '' || url.password !== '' || url.search !== '' || url.pathname.length > 1;
  if (!carriesCredential) return [];
  const parts = new Set<string>([value, url.href, url.username, url.password]);
  for (const segment of url.pathname.split('/')) if (segment.length >= 12) parts.add(segment);
  for (const [, v] of url.searchParams) if (v.length >= 8) parts.add(v);
  return [...parts].filter(Boolean);
}

function render(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(value);
  }
}

export function createLogger(
  level: LogLevel = 'info',
  sink: (line: string) => void = console.log,
  secrets: readonly string[] = [],
): Logger {
  const emit = (lvl: LogLevel, message: string, extra: unknown[]) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = [message, ...extra.map(render)].join(' ');
    sink(redact(`${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${line}`, secrets));
  };
  return {
    debug: (m, ...e) => emit('debug', m, e),
    info: (m, ...e) => emit('info', m, e),
    warn: (m, ...e) => emit('warn', m, e),
    error: (m, ...e) => emit('error', m, e),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
